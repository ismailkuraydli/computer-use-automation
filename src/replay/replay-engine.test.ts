import { describe, it, expect, afterEach } from "vitest";
import { rmSync } from "fs";
import path from "path";
import { ReplayEngine } from "./replay-engine.js";
import { EvidenceCollector } from "../evidence/evidence-collector.js";
import type { Surface, ScreenState, Action, ActionResult } from "../surface/types.js";
import type { CapabilityArtifact, ArtifactStep } from "../artifact/types.js";
import type { AppProfile } from "../artifact/profile-types.js";
import type { EscalationResult, HandoffRequest, OperatorSignal } from "../escalation/escalation-manager.js";

/** A fake operator: optionally changes the screen, then signals. */
class FakeHandoff {
  readonly requests: HandoffRequest[] = [];
  constructor(
    private surface: ScriptedSurface,
    private signal: OperatorSignal,
    private afterHuman?: ScreenState,
    private checkpointPassed = false
  ) {}

  async handoff(request: HandoffRequest): Promise<EscalationResult> {
    this.requests.push(request);
    if (this.afterHuman) this.surface.setScreen(this.afterHuman);
    return {
      signal: this.signal,
      humanActions: [{ action: "click", target: 'button "Close"', timestamp: "t", result: "success" }],
      checkpointPassed: this.checkpointPassed,
      escalated: true,
    };
  }
}

const TEST_EVIDENCE_DIR = path.join(process.cwd(), "test-evidence-replay");
const FAST_CHECKPOINT_MS = 50;

/** Each act() returns the next scripted result and moves the screen to its state. */
class ScriptedSurface implements Surface {
  readonly actions: Action[] = [];
  private current: ScreenState;

  constructor(private script: Array<{ result: ActionResult; state: ScreenState }>, initial = screen("about:blank")) {
    this.current = initial;
  }

  async observe(): Promise<ScreenState> {
    return this.current;
  }

  async act(action: Action): Promise<ActionResult> {
    this.actions.push(action);
    const next = this.script.shift();
    if (!next) throw new Error(`Unscripted action: ${action.type}`);
    this.current = next.state;
    return next.result;
  }

  setScreen(state: ScreenState): void {
    this.current = state;
  }

  async navigate(): Promise<ActionResult> {
    return { ok: true };
  }

  async close(): Promise<void> {}
}

function screen(url: string, texts: string[] = [], controls: Array<[string, string]> = []): ScreenState {
  return {
    url,
    title: "Keystone",
    axTree: [
      ...texts.map((name) => ({ role: "StaticText", name })),
      ...controls.map(([role, name]) => ({ role, name })),
    ],
    domSnapshot: "",
    frameUrls: [],
  };
}

const OK: ActionResult = { ok: true };
const SEARCH = screen("http://localhost:3000/search", [], [["textbox", "Member ID"], ["button", "Search"]]);
const RESULTS = screen("http://localhost:3000/search?q=12345", [], [["link", "12345"]]);
const NOT_FOUND = screen("http://localhost:3000/search?q=99999", ["No records found for Member ID: 99999"]);
const UNAVAILABLE = screen("http://localhost:3000/search", ["503 Service Temporarily Unavailable"]);
const NOTICE = screen("http://localhost:3000/search", ["System Notice"], [["button", "Acknowledge"]]);

const PROFILE: AppProfile = {
  schemaVersion: "1.0",
  app: "keystone-cu",
  version: 1,
  interstitials: [
    {
      name: "System Notice",
      when: { anyOf: [{ axContains: [{ role: "button", name: "Acknowledge" }] }] },
      dismiss: { role: "button", name: "Acknowledge" },
    },
  ],
  conditions: [
    { when: { anyOf: [{ textContains: "No records found" }] }, kind: "business-outcome", outcome: "not-found", description: "Member does not exist" },
    { when: { anyOf: [{ textContains: "Service Temporarily Unavailable" }] }, kind: "retry", maxRetries: 1, description: "Transient error" },
  ],
};

const NAVIGATE: ArtifactStep = {
  id: 1,
  action: "navigate",
  value: "http://localhost:3000/search",
  checkpoint: { anyOf: [{ axContains: [{ role: "textbox", name: "Member ID" }] }] },
};
const TYPE: ArtifactStep = { id: 2, action: "type", target: { role: "textbox", name: "Member ID" }, value: "{{memberId}}" };
const SEARCH_CLICK: ArtifactStep = {
  id: 3,
  action: "click",
  target: { role: "button", name: "Search" },
  checkpoint: { anyOf: [{ axContains: [{ role: "link", name: "{{memberId}}" }] }] },
};
const EXTRACT: ArtifactStep = { id: 4, action: "extract", target: { role: "link", name: "{{memberId}}" }, output: "memberLink" };

function artifact(steps: ArtifactStep[], overrides: Partial<CapabilityArtifact> = {}): CapabilityArtifact {
  return {
    schemaVersion: "2.0",
    artifactVersion: 1,
    capability: "lookup-member",
    description: "Look up a member",
    surface: { type: "web", baseUrl: "http://localhost:3000", app: "keystone-cu" },
    params: [{ name: "memberId", type: "string", required: true }],
    outputs: [{ name: "memberLink", type: "string" }],
    allowlist: {
      permittedDomains: ["localhost"],
      permittedUrlPatterns: ["/*"],
      permittedActions: ["navigate", "click", "type", "extract", "submit"],
      irreversibleActions: ["submit"],
    },
    steps,
    checkpoint: { outputsExtracted: true },
    metadata: { recordedAt: "2026-09-24T00:00:00Z", recordedBy: "test" },
    ...overrides,
  };
}

function engine(surface: Surface, handoff?: FakeHandoff): ReplayEngine {
  return new ReplayEngine({
    surface,
    evidenceCollector: new EvidenceCollector(TEST_EVIDENCE_DIR),
    profile: PROFILE,
    checkpointTimeoutMs: FAST_CHECKPOINT_MS,
    handoff,
  });
}

describe("ReplayEngine", () => {
  afterEach(() => rmSync(TEST_EVIDENCE_DIR, { recursive: true, force: true }));

  it("replays every step, substitutes params and returns outputs", async () => {
    const surface = new ScriptedSurface([
      { result: OK, state: SEARCH },
      { result: OK, state: SEARCH },
      { result: OK, state: RESULTS },
      { result: { ok: true, extractedValue: "12345" }, state: RESULTS },
    ]);

    const result = await engine(surface).run(artifact([NAVIGATE, TYPE, SEARCH_CLICK, EXTRACT]), { memberId: "12345" });

    expect(result).toMatchObject({ status: "success", outputs: { memberLink: "12345" } });
    expect(surface.actions[1]).toMatchObject({ type: "type", value: "12345" });
    expect(surface.actions[3].target).toEqual({ role: "link", name: "12345" });
  });

  it("returns a business outcome when a known condition replaces the checkpoint", async () => {
    const surface = new ScriptedSurface([
      { result: OK, state: SEARCH },
      { result: OK, state: SEARCH },
      { result: OK, state: NOT_FOUND },
    ]);

    const result = await engine(surface).run(artifact([NAVIGATE, TYPE, SEARCH_CLICK, EXTRACT]), { memberId: "99999" });

    expect(result).toMatchObject({ status: "business-outcome", outcome: "not-found" });
  });

  it("retries a transient condition, then continues", async () => {
    const surface = new ScriptedSurface([
      { result: OK, state: UNAVAILABLE },
      { result: OK, state: SEARCH },
    ]);

    const result = await engine(surface).run(artifact([NAVIGATE], { outputs: [], checkpoint: {} }), { memberId: "1" });

    expect(result.status).toBe("success");
    expect(surface.actions).toHaveLength(2);
  });

  it("treats a known error page as a failure even when the checkpoint matches", async () => {
    const urlOnly: ArtifactStep = { ...NAVIGATE, checkpoint: { anyOf: [{ urlPattern: "/search" }] } };
    const surface = new ScriptedSurface([
      { result: OK, state: UNAVAILABLE },
      { result: OK, state: SEARCH },
    ]);

    const result = await engine(surface).run(artifact([urlOnly], { outputs: [], checkpoint: {} }), { memberId: "1" });

    expect(result.status).toBe("success");
    expect(surface.actions).toHaveLength(2);
  });

  it("stops retrying after maxRetries", async () => {
    const surface = new ScriptedSurface([
      { result: OK, state: UNAVAILABLE },
      { result: OK, state: UNAVAILABLE },
    ]);

    const result = await engine(surface).run(artifact([NAVIGATE], { outputs: [], checkpoint: {} }), { memberId: "1" });

    expect(result).toMatchObject({ status: "failure", stepId: 1, error: "retries-exhausted" });
  });

  it("fails hard when the checkpoint never holds on an unknown screen", async () => {
    const surface = new ScriptedSurface([{ result: OK, state: screen("http://localhost:3000/elsewhere") }]);

    const result = await engine(surface).run(artifact([NAVIGATE], { outputs: [], checkpoint: {} }), { memberId: "1" });

    expect(result).toMatchObject({ status: "failure", stepId: 1, error: "checkpoint-failed" });
  });

  it("dismisses a known interstitial that blocks an action, then retries it", async () => {
    const surface = new ScriptedSurface([
      { result: { ok: false, error: "blocked", detail: "covered by <div>" }, state: NOTICE },
      { result: OK, state: SEARCH },
      { result: OK, state: RESULTS },
    ]);

    const result = await engine(surface).run(artifact([SEARCH_CLICK], { outputs: [], checkpoint: {} }), { memberId: "12345" });

    expect(result.status).toBe("success");
    expect(surface.actions.map((a) => a.target?.name)).toEqual(["Search", "Acknowledge", "Search"]);
  });

  it("escalates when unknown UI blocks the action", async () => {
    const surface = new ScriptedSurface([
      { result: { ok: false, error: "blocked", detail: "covered by <div id=promo>" }, state: SEARCH },
    ]);

    const result = await engine(surface).run(artifact([SEARCH_CLICK], { outputs: [], checkpoint: {} }), { memberId: "12345" });

    expect(result).toMatchObject({ status: "escalated", stepId: 3 });
  });

  it("escalates an unexpected native dialog", async () => {
    const surface = new ScriptedSurface([
      { result: { ok: false, error: "unexpected-dialog", detail: "confirm: Are you sure?" }, state: SEARCH },
    ]);

    const result = await engine(surface).run(artifact([SEARCH_CLICK], { outputs: [], checkpoint: {} }), { memberId: "12345" });

    expect(result).toMatchObject({ status: "escalated" });
  });

  it("reports an ambiguous target as a hard failure", async () => {
    const surface = new ScriptedSurface([
      { result: { ok: false, error: "ambiguous", detail: "2 matches" }, state: SEARCH },
    ]);

    const result = await engine(surface).run(artifact([SEARCH_CLICK], { outputs: [], checkpoint: {} }), { memberId: "12345" });

    expect(result).toMatchObject({ status: "failure", error: "ambiguous" });
  });

  it("escalates an irreversible step without caller confirmation, before acting", async () => {
    const submit: ArtifactStep = { id: 1, action: "submit", target: { role: "button", name: "Continue" }, classification: "irreversible" };
    const surface = new ScriptedSurface([]);

    const result = await engine(surface).run(artifact([submit], { outputs: [], checkpoint: {} }), { memberId: "1" });

    expect(result).toMatchObject({ status: "escalated", stepId: 1 });
    expect(surface.actions).toHaveLength(0);
  });

  it("runs an irreversible step when the caller confirms", async () => {
    const submit: ArtifactStep = { id: 1, action: "submit", target: { role: "button", name: "Continue" }, classification: "irreversible" };
    const surface = new ScriptedSurface([{ result: OK, state: SEARCH }]);

    const result = await engine(surface).run(artifact([submit], { outputs: [], checkpoint: {} }), { memberId: "1" }, { confirmIrreversible: true });

    expect(result.status).toBe("success");
  });

  it("never retries an irreversible step", async () => {
    const submit: ArtifactStep = {
      id: 1,
      action: "submit",
      target: { role: "button", name: "Continue" },
      classification: "irreversible",
      checkpoint: { anyOf: [{ textContains: "Opened Successfully" }] },
    };
    const surface = new ScriptedSurface([{ result: OK, state: UNAVAILABLE }]);

    const result = await engine(surface).run(artifact([submit], { outputs: [], checkpoint: {} }), { memberId: "1" }, { confirmIrreversible: true });

    expect(result).toMatchObject({ status: "escalated" });
    expect(surface.actions).toHaveLength(1);
  });

  it("rejects a run with missing required params without acting", async () => {
    const surface = new ScriptedSurface([]);

    const result = await engine(surface).run(artifact([NAVIGATE]), {});

    expect(result).toMatchObject({ status: "failure", stepId: 0, error: "missing-params" });
    expect(surface.actions).toHaveLength(0);
  });

  it("refuses to navigate outside the allowlist", async () => {
    const offsite: ArtifactStep = { id: 1, action: "navigate", value: "https://evil.example.com/" };
    const surface = new ScriptedSurface([]);

    const result = await engine(surface).run(artifact([offsite]), { memberId: "1" });

    expect(result).toMatchObject({ status: "failure", error: "policy-violation" });
    expect(surface.actions).toHaveLength(0);
  });

  it("fails when a declared output was not extracted", async () => {
    const surface = new ScriptedSurface([{ result: OK, state: SEARCH }]);

    const result = await engine(surface).run(artifact([NAVIGATE]), { memberId: "1" });

    expect(result).toMatchObject({ status: "failure", error: "missing-outputs" });
  });

  it("turns a thrown surface error into a failure instead of crashing", async () => {
    const surface = new ScriptedSurface([]);
    surface.act = async () => {
      throw new Error("page crashed");
    };

    const result = await engine(surface).run(artifact([NAVIGATE]), { memberId: "1" });

    expect(result).toMatchObject({ status: "failure", stepId: 1, error: "surface-error", observed: "page crashed" });
  });

  it("never retries an action the allowlist marks irreversible, even without a step classification", async () => {
    const submit: ArtifactStep = {
      id: 1,
      action: "submit",
      target: { role: "button", name: "Continue" },
      checkpoint: { anyOf: [{ textContains: "Opened Successfully" }] },
    };
    const surface = new ScriptedSurface([{ result: OK, state: UNAVAILABLE }]);

    const result = await engine(surface).run(artifact([submit], { outputs: [], checkpoint: {} }), { memberId: "1" }, { confirmIrreversible: true });

    expect(result).toMatchObject({ status: "escalated" });
    expect(surface.actions).toHaveLength(1);
  });

  describe("handoff to a human on the live session", () => {
    const BLOCKED: ActionResult = { ok: false, error: "blocked", detail: "covered by <div id=promo>" };
    const noOutputs = { outputs: [], checkpoint: {} };

    it("continues after the human completes the step and its checkpoint holds", async () => {
      const surface = new ScriptedSurface([{ result: BLOCKED, state: SEARCH }]);
      const human = new FakeHandoff(surface, "done", RESULTS, true);

      const result = await engine(surface, human).run(artifact([SEARCH_CLICK], noOutputs), { memberId: "12345" });

      expect(result).toMatchObject({ status: "success", humanActions: [{ action: "click" }] });
      expect(human.requests[0]).toMatchObject({ capability: "lookup-member", stepId: 3 });
      expect(human.requests[0].checkpoint).toEqual({ anyOf: [{ axContains: [{ role: "link", name: "12345" }] }] });
      expect(surface.actions).toHaveLength(1);
    });

    it("re-runs the step after the human clears the blocker", async () => {
      const surface = new ScriptedSurface([
        { result: BLOCKED, state: SEARCH },
        { result: OK, state: RESULTS },
      ]);
      const human = new FakeHandoff(surface, "done", SEARCH, false);

      const result = await engine(surface, human).run(artifact([SEARCH_CLICK], noOutputs), { memberId: "12345" });

      expect(result.status).toBe("success");
      expect(surface.actions.map((a) => a.target?.name)).toEqual(["Search", "Search"]);
    });

    it("ends the run when the human finishes the task themselves", async () => {
      const surface = new ScriptedSurface([{ result: BLOCKED, state: SEARCH }]);

      const result = await engine(surface, new FakeHandoff(surface, "complete")).run(artifact([SEARCH_CLICK], noOutputs), { memberId: "12345" });

      expect(result).toMatchObject({ status: "escalated", resolution: "completed-by-human", humanActions: [{ action: "click" }] });
    });

    it("ends the run when the human aborts", async () => {
      const surface = new ScriptedSurface([{ result: BLOCKED, state: SEARCH }]);

      const result = await engine(surface, new FakeHandoff(surface, "abort")).run(artifact([SEARCH_CLICK], noOutputs), { memberId: "12345" });

      expect(result).toMatchObject({ status: "escalated", resolution: "aborted" });
    });

    it("lets a human approve an unconfirmed irreversible step", async () => {
      const submit: ArtifactStep = { id: 1, action: "submit", target: { role: "button", name: "Continue" }, classification: "irreversible" };
      const surface = new ScriptedSurface([{ result: OK, state: SEARCH }]);
      const human = new FakeHandoff(surface, "done");

      const result = await engine(surface, human).run(artifact([submit], noOutputs), { memberId: "1" });

      expect(result.status).toBe("success");
      expect(human.requests[0].reason).toMatch(/irreversible/);
      expect(human.requests[0].checkpoint).toBeUndefined();
      expect(surface.actions).toHaveLength(1);
    });

    it("stops handing off after the per-step limit", async () => {
      const surface = new ScriptedSurface([
        { result: BLOCKED, state: SEARCH },
        { result: BLOCKED, state: SEARCH },
        { result: BLOCKED, state: SEARCH },
      ]);
      const human = new FakeHandoff(surface, "done", SEARCH, false);

      const result = await engine(surface, human).run(artifact([SEARCH_CLICK], noOutputs), { memberId: "12345" });

      expect(result).toMatchObject({ status: "escalated", resolution: "unresolved" });
      expect(human.requests).toHaveLength(2);
    });
  });
});
