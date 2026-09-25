import { describe, it, expect, afterEach } from "vitest";
import { ControlState } from "./control-state.js";
import { EscalationManager } from "./escalation-manager.js";
import { HumanActionRecorder } from "./human-action-recorder.js";
import { createEscalationRequest } from "./escalation-request.js";
import { MockSurface } from "../surface/mock-surface.js";
import { EvidenceCollector } from "../evidence/evidence-collector.js";
import { rmSync } from "fs";
import path from "path";

const TEST_EVIDENCE_DIR = path.join(process.cwd(), "test-evidence-escalation");

describe("ControlState", () => {
  // AC6: Given a control state of automation, when any action is attempted outside
  // the automation loop, then the control-state machine rejects it.

  it("starts in automation state", () => {
    const cs = new ControlState();
    expect(cs.current).toBe("automation");
  });

  it("allows automation → paused transition", () => {
    const cs = new ControlState();
    expect(cs.transition("paused")).toBe(true);
    expect(cs.current).toBe("paused");
  });

  it("allows paused → human transition", () => {
    const cs = new ControlState();
    cs.transition("paused");
    expect(cs.transition("human")).toBe(true);
    expect(cs.current).toBe("human");
  });

  it("allows human → resuming transition", () => {
    const cs = new ControlState();
    cs.transition("paused");
    cs.transition("human");
    expect(cs.transition("resuming")).toBe(true);
    expect(cs.current).toBe("resuming");
  });

  it("allows resuming → automation transition", () => {
    const cs = new ControlState();
    cs.transition("paused");
    cs.transition("human");
    cs.transition("resuming");
    expect(cs.transition("automation")).toBe(true);
    expect(cs.current).toBe("automation");
  });

  it("rejects automation → human (must pause first)", () => {
    const cs = new ControlState();
    expect(cs.transition("human")).toBe(false);
    expect(cs.current).toBe("automation");
  });

  it("rejects paused → automation (must go through human first)", () => {
    const cs = new ControlState();
    cs.transition("paused");
    expect(cs.transition("automation")).toBe(false);
  });

  it("records transition history", () => {
    const cs = new ControlState();
    cs.transition("paused");
    cs.transition("human");
    expect(cs.history).toHaveLength(2);
    expect(cs.history[0].from).toBe("automation");
    expect(cs.history[0].to).toBe("paused");
  });

  it("allows terminal transitions to done", () => {
    const cs = new ControlState();
    cs.transition("paused");
    expect(cs.transition("done")).toBe(true);
    expect(cs.current).toBe("done");
  });
});

describe("HumanActionRecorder", () => {
  it("records human actions", () => {
    const recorder = new HumanActionRecorder();
    recorder.record("click", "Search button", "success");
    recorder.record("type", "Member ID field", "success");
    expect(recorder.actions).toHaveLength(2);
    expect(recorder.actions[0].action).toBe("click");
    expect(recorder.actions[0].target).toBe("Search button");
  });

  it("clears actions", () => {
    const recorder = new HumanActionRecorder();
    recorder.record("click", "button", "success");
    recorder.clear();
    expect(recorder.actions).toHaveLength(0);
  });
});

describe("EscalationRequest", () => {
  it("creates an escalation request with all context fields", () => {
    const state = {
      url: "http://localhost:3000/search",
      title: "Search",
      axTree: [],
      domSnapshot: "",
      frameUrls: [],
    };
    const req = createEscalationRequest("lookup-member", 3, state as any, "hard failure");
    expect(req.capability).toBe("lookup-member");
    expect(req.stepId).toBe(3);
    expect(req.reason).toBe("hard failure");
    expect(req.screenState.url).toBe("http://localhost:3000/search");
    expect(req.timestamp).toBeTruthy();
  });
});

describe("EscalationManager", () => {
  afterEach(() => {
    rmSync(TEST_EVIDENCE_DIR, { recursive: true, force: true });
  });

  // AC1: Given an automation run that hits a hard failure, when EscalationManager.escalate()
  // is called, then the control state transitions to paused and an EscalationRequest is created.
  it("escalate transitions to paused and creates EscalationRequest", async () => {
    const surface = new MockSurface("http://localhost:3000/search", [
      { role: "textbox", name: "Member ID" },
    ]);
    const evidence = new EvidenceCollector(TEST_EVIDENCE_DIR);
    const manager = new EscalationManager(surface, evidence);

    const request = await manager.escalate("lookup-member", 2, "hard failure: element not found");

    expect(manager.state).toBe("paused");
    expect(request.capability).toBe("lookup-member");
    expect(request.stepId).toBe(2);
    expect(request.reason).toContain("hard failure");
    expect(request.screenState).toBeDefined();
  });

  // AC2: Given a paused session, when the operator connects, control state transitions to human.
  it("operatorConnected transitions to human state", async () => {
    const surface = new MockSurface("http://localhost:3000/search", []);
    const evidence = new EvidenceCollector(TEST_EVIDENCE_DIR);
    const manager = new EscalationManager(surface, evidence);

    await manager.escalate("test", 1, "stuck");
    expect(manager.operatorConnected()).toBe(true);
    expect(manager.state).toBe("human");
  });

  // AC3: Given the operator signals done, control state transitions and checkpoint is verified.
  it("done signal verifies checkpoint and resumes", async () => {
    const surface = new MockSurface("http://localhost:3000/search", [
      { role: "textbox", name: "Member ID" },
    ]);
    surface.setStateSequence([
      {
        url: "http://localhost:3000/search",
        title: "Search",
        axTree: [{ role: "textbox", name: "Member ID" }],
        domSnapshot: "", frameUrls: [],
      },
    ]);
    const evidence = new EvidenceCollector(TEST_EVIDENCE_DIR);
    const manager = new EscalationManager(surface, evidence);

    await manager.escalate("test", 1, "stuck");
    manager.operatorConnected();
    manager.recordHumanAction("click", "Search button", "success");

    const checkpoint = { anyOf: [{ axContains: [{ role: "textbox", name: "Member ID" }] }] };
    const result = await manager.processSignal("done", checkpoint);

    expect(result.signal).toBe("done");
    expect(result.checkpointPassed).toBe(true);
    expect(result.humanActions).toHaveLength(1);
    expect(manager.state).toBe("automation");
  });

  // AC4: Given the operator signals complete, returns escalated result with human actions.
  it("complete signal returns escalated result with human actions", async () => {
    const surface = new MockSurface("http://localhost:3000/search", []);
    const evidence = new EvidenceCollector(TEST_EVIDENCE_DIR);
    const manager = new EscalationManager(surface, evidence);

    await manager.escalate("test", 1, "stuck");
    manager.operatorConnected();
    manager.recordHumanAction("type", "Member ID", "success");
    manager.recordHumanAction("click", "Search", "success");

    const result = await manager.processSignal("complete");

    expect(result.signal).toBe("complete");
    expect(result.escalated).toBe(true);
    expect(result.humanActions).toHaveLength(2);
    expect(manager.state).toBe("done");
  });

  // AC5: Given the operator signals abort, returns failure result.
  it("abort signal returns failure result", async () => {
    const surface = new MockSurface("http://localhost:3000/search", []);
    const evidence = new EvidenceCollector(TEST_EVIDENCE_DIR);
    const manager = new EscalationManager(surface, evidence);

    await manager.escalate("test", 1, "stuck");
    manager.operatorConnected();
    manager.recordHumanAction("click", "some button", "failure");

    const result = await manager.processSignal("abort");

    expect(result.signal).toBe("abort");
    expect(result.escalated).toBe(false);
    expect(result.checkpointPassed).toBe(false);
    expect(result.humanActions).toHaveLength(1);
    expect(manager.state).toBe("done");
  });

  // AC8: irreversible action escalation
  it("escalates irreversible action before execution", async () => {
    const surface = new MockSurface("http://localhost:3000/detail", []);
    const evidence = new EvidenceCollector(TEST_EVIDENCE_DIR);
    const manager = new EscalationManager(surface, evidence);

    const request = await manager.escalate("delete-account", 5, "irreversible-action-requires-approval");

    expect(manager.state).toBe("paused");
    expect(request.reason).toContain("irreversible");
  });

  it("checkpoint fails when state doesn't match", async () => {
    const surface = new MockSurface("http://localhost:3000/search", [
      { role: "button", name: "Wrong" },
    ]);
    surface.setStateSequence([
      {
        url: "http://localhost:3000/wrong",
        title: "Wrong Page",
        axTree: [{ role: "button", name: "Wrong" }],
        domSnapshot: "", frameUrls: [],
      },
    ]);
    const evidence = new EvidenceCollector(TEST_EVIDENCE_DIR);
    const manager = new EscalationManager(surface, evidence);

    await manager.escalate("test", 1, "stuck");
    manager.operatorConnected();

    const checkpoint = { anyOf: [{ axContains: [{ role: "textbox", name: "Member ID" }] }] };
    const result = await manager.processSignal("done", checkpoint);

    expect(result.checkpointPassed).toBe(false);
    // Automation takes control back and re-runs the step
    expect(manager.state).toBe("automation");
  });
});
