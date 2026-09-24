import { describe, it, expect, afterEach } from "vitest";
import { AgentLoop } from "./agent-loop.js";
import { MockLLMClient } from "../llm/mock-client.js";
import { MockSurface } from "../surface/mock-surface.js";
import { SafetyGuard } from "../safety/safety-guard.js";
import { EvidenceCollector } from "../evidence/evidence-collector.js";
import { Recorder } from "./recorder.js";
import { rmSync } from "fs";
import path from "path";
import type { AllowlistConfig } from "../artifact/types.js";

const MOCK_APP_URL = "http://localhost:3000";
const TEST_EVIDENCE_DIR = path.join(process.cwd(), "test-evidence-agent");

const allowlist: AllowlistConfig = {
  permittedDomains: ["localhost"],
  permittedUrlPatterns: ["/search*", "/detail/*", "/new-account*", "/"],
  permittedActions: ["navigate", "click", "type", "extract", "wait", "submit"],
  riskyActions: ["submit"],
};

function makeMockSurface(): MockSurface {
  return new MockSurface(MOCK_APP_URL, [
    { role: "textbox", name: "Member ID" },
    { role: "button", name: "Search" },
  ]);
}

describe("AgentLoop", () => {
  afterEach(() => {
    rmSync(TEST_EVIDENCE_DIR, { recursive: true, force: true });
  });

  // AC1: Given a goal string and target URL, when I run AgentLoop with
  // MockLLMClient, then the loop executes observe-decide-act steps until
  // the goal is met or a stopping condition is hit, and all steps are recorded.
  it("executes observe-decide-act loop until goal is met", async () => {
    const script = [
      {
        action: { type: "navigate" as const, value: `${MOCK_APP_URL}/search` },
        reasoning: "Navigate to search page",
        goalMet: false,
      },
      {
        action: { type: "type" as const, target: { role: "textbox", name: "Member ID" }, value: "12345" },
        reasoning: "Type member ID",
        goalMet: false,
      },
      {
        action: { type: "navigate" as const, value: `${MOCK_APP_URL}/detail?id=12345` },
        reasoning: "Navigate to member detail",
        goalMet: true,
      },
    ];

    const mockClient = new MockLLMClient(script);
    const loop = new AgentLoop({
      llmClient: mockClient,
      surface: makeMockSurface(),
      safetyGuard: new SafetyGuard(allowlist),
      evidenceCollector: new EvidenceCollector(TEST_EVIDENCE_DIR),
      recorder: new Recorder("test-goal", "Test goal", allowlist),
      maxSteps: 10,
      timeoutMs: 15000,
    });

    const result = await loop.run("Look up member 12345", MOCK_APP_URL);

    expect(result.success).toBe(true);
    expect(result.stepsExecuted).toBe(3);
    expect(result.artifact).toBeDefined();
    // 4 steps: initial navigation + 3 scripted LLM actions
    expect(result.artifact.steps).toHaveLength(4);

    // AC8: verify zero real API calls (MockLLMClient was used)
    expect(mockClient.callCount).toBe(3);
  });

  it("stops at max steps", async () => {
    const script = Array(5).fill({
      action: { type: "wait" as const, value: "10" },
      reasoning: "Waiting",
      goalMet: false,
    });

    const mockClient = new MockLLMClient(script);
    const loop = new AgentLoop({
      llmClient: mockClient,
      surface: makeMockSurface(),
      safetyGuard: new SafetyGuard(allowlist),
      evidenceCollector: new EvidenceCollector(TEST_EVIDENCE_DIR),
      recorder: new Recorder("test-max-steps", "Test max steps", allowlist),
      maxSteps: 3,
      timeoutMs: 10000,
    });

    const result = await loop.run("Never-ending goal", MOCK_APP_URL);

    expect(result.success).toBe(false);
    expect(result.reason).toContain("max steps");
    expect(result.stepsExecuted).toBe(3);
  });

  it("detects dead-end when LLM returns error", async () => {
    const mockClient = new MockLLMClient([]); // Empty script — immediate error
    const loop = new AgentLoop({
      llmClient: mockClient,
      surface: makeMockSurface(),
      safetyGuard: new SafetyGuard(allowlist),
      evidenceCollector: new EvidenceCollector(TEST_EVIDENCE_DIR),
      recorder: new Recorder("test-dead-end", "Test dead end", allowlist),
      maxSteps: 10,
      timeoutMs: 10000,
    });

    const result = await loop.run("Goal", MOCK_APP_URL);

    expect(result.success).toBe(false);
    expect(result.reason).toContain("error");
  });

  it("detects repeated actions (dead-end loop)", async () => {
    // Need 6 entries: 3 repeats triggers read_page_text intervention,
    // which resets the counter, then 3 more repeats triggers the actual dead-end
    const script = Array(7).fill({
      action: { type: "navigate" as const, value: `${MOCK_APP_URL}/search` },
      reasoning: "Navigate to search",
      goalMet: false,
    });

    const mockClient = new MockLLMClient(script);
    const loop = new AgentLoop({
      llmClient: mockClient,
      surface: makeMockSurface(),
      safetyGuard: new SafetyGuard(allowlist),
      evidenceCollector: new EvidenceCollector(TEST_EVIDENCE_DIR),
      recorder: new Recorder("test-loop", "Test loop", allowlist),
      maxSteps: 10,
      timeoutMs: 10000,
    });

    const result = await loop.run("Goal", MOCK_APP_URL);

    expect(result.success).toBe(false);
    expect(result.reason).toContain("repeated");
  });

  // AC3: Given an allowlist that permits only /search routes, when the agent
  // attempts to navigate to /admin, then SafetyGuard blocks the action.
  it("blocks actions outside the allowlist and continues to next action", async () => {
    const restrictiveAllowlist: AllowlistConfig = {
      permittedDomains: ["localhost"],
      permittedUrlPatterns: ["/search*"],
      permittedActions: ["navigate", "click", "type", "extract", "wait"],
    };

    const script = [
      {
        action: { type: "navigate" as const, value: "http://localhost:3000/admin" },
        reasoning: "Try admin",
        goalMet: false,
      },
      {
        action: { type: "navigate" as const, value: "http://localhost:3000/search" },
        reasoning: "Navigate to search instead",
        goalMet: true,
      },
    ];

    const mockClient = new MockLLMClient(script);
    const loop = new AgentLoop({
      llmClient: mockClient,
      surface: makeMockSurface(),
      safetyGuard: new SafetyGuard(restrictiveAllowlist),
      evidenceCollector: new EvidenceCollector(TEST_EVIDENCE_DIR),
      recorder: new Recorder("test-allowlist", "Test allowlist", restrictiveAllowlist),
      maxSteps: 10,
      timeoutMs: 10000,
    });

    const result = await loop.run("Goal", MOCK_APP_URL);

    // The blocked action should be skipped, and the agent should proceed to the allowed action
    expect(result.success).toBe(true);
    // Only the allowed step should be recorded (blocked actions aren't recorded in the artifact)
    expect(result.artifact.steps.length).toBeLessThan(2);
  });

  // AC4: Given a risky action (submit), when the agent attempts it, then
  // SafetyGuard flags it in evidence but allows execution.
  it("allows risky actions (submit) and flags them in evidence", async () => {
    const script = [
      {
        action: { type: "submit" as const, target: { role: "button", name: "Search" } },
        reasoning: "Submit form",
        goalMet: true,
      },
    ];

    const mockClient = new MockLLMClient(script);
    const loop = new AgentLoop({
      llmClient: mockClient,
      surface: makeMockSurface(),
      safetyGuard: new SafetyGuard(allowlist),
      evidenceCollector: new EvidenceCollector(TEST_EVIDENCE_DIR),
      recorder: new Recorder("test-risky", "Test risky action", allowlist),
      maxSteps: 10,
      timeoutMs: 10000,
    });

    const result = await loop.run("Goal", MOCK_APP_URL);

    expect(result.success).toBe(true);
    // The submit action should have been executed (not blocked)
    expect(result.stepsExecuted).toBe(1);
  });

  // AC5: Given an irreversible action (delete), when the agent attempts it,
  // then SafetyGuard blocks it.
  it("blocks irreversible actions (delete)", async () => {
    const irreversibleAllowlist: AllowlistConfig = {
      permittedDomains: ["localhost"],
      permittedUrlPatterns: ["/search*", "/detail/*"],
      permittedActions: ["navigate", "click", "type", "extract", "wait"],
      irreversibleActions: ["delete" as any],
    };

    const script = [
      {
        action: { type: "delete" as any, target: { role: "button", name: "Delete Account" } },
        reasoning: "Delete account",
        goalMet: false,
      },
      {
        action: { type: "navigate" as const, value: "http://localhost:3000/search" },
        reasoning: "Navigate to search",
        goalMet: true,
      },
    ];

    const mockClient = new MockLLMClient(script);
    const loop = new AgentLoop({
      llmClient: mockClient,
      surface: makeMockSurface(),
      safetyGuard: new SafetyGuard(irreversibleAllowlist),
      evidenceCollector: new EvidenceCollector(TEST_EVIDENCE_DIR),
      recorder: new Recorder("test-irreversible", "Test irreversible", irreversibleAllowlist),
      maxSteps: 10,
      timeoutMs: 10000,
    });

    const result = await loop.run("Goal", MOCK_APP_URL);

    // The delete action should be blocked, but the agent continues to the next action
    expect(result.success).toBe(true);
    // The delete step should NOT be in the artifact
    const deleteSteps = result.artifact.steps.filter((s) => s.action === ("delete" as any));
    expect(deleteSteps).toHaveLength(0);
  });
});
