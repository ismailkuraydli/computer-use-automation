import { describe, it, expect } from "vitest";
import { Recorder } from "./recorder.js";
import type { Action, ScreenState, AXNode } from "../surface/types.js";
import type { AllowlistConfig } from "../artifact/types.js";

const allowlist: AllowlistConfig = {
  permittedDomains: ["localhost"],
  permittedUrlPatterns: ["/search*", "/detail/*"],
  permittedActions: ["navigate", "click", "type", "extract"],
};

function mockScreenState(url: string, axTree: AXNode[] = []): ScreenState {
  return {
    url,
    title: "Test Page",
    axTree,
    domSnapshot: "<html></html>",
    frameUrls: [url],
  };
}

describe("Recorder", () => {
  // AC2: Given MockLLMClient returns scripted actions, when AgentLoop runs,
  // then the Recorder produces a valid CapabilityArtifact with typed params,
  // outputs, steps, locators, guards, and checkpoints.

  it("transforms a navigate action into an artifact step", () => {
    const recorder = new Recorder("test-capability", "Test capability", allowlist);
    const action: Action = { type: "navigate", value: "http://localhost:3000/search" };
    const beforeState = mockScreenState("http://localhost:3000/");
    const afterState = mockScreenState("http://localhost:3000/search", [
      { role: "textbox", name: "Member ID" },
    ]);

    recorder.recordAction(action, beforeState, afterState, "success");

    const artifact = recorder.finalize(
      [{ name: "memberId", type: "string", required: true }],
      [{ name: "savingsBalance", type: "string" }],
      { outputsExtracted: true }
    );

    expect(artifact.steps).toHaveLength(1);
    expect(artifact.steps[0].action).toBe("navigate");
    expect(artifact.steps[0].target).toBeDefined();
    expect(artifact.steps[0].value).toBe("http://localhost:3000/search");
  });

  it("extracts a locator from the AX tree for click actions", () => {
    const recorder = new Recorder("test-capability", "Test capability", allowlist);
    const beforeState = mockScreenState("http://localhost:3000/search", [
      { role: "textbox", name: "Member ID" },
      { role: "button", name: "Search" },
    ]);
    const afterState = mockScreenState("http://localhost:3000/search?q=12345", [
      { role: "link", name: "12345" },
    ]);

    recorder.recordAction(
      { type: "click", target: { role: "button", name: "Search" } },
      beforeState,
      afterState,
      "success"
    );

    const artifact = recorder.finalize([], [], { outputsExtracted: true });
    expect(artifact.steps).toHaveLength(1);
    expect(artifact.steps[0].action).toBe("click");
    expect(artifact.steps[0].target.primary.role).toBe("button");
    expect(artifact.steps[0].target.primary.name).toBe("Search");
  });

  it("generates a checkpoint from the after-state AX tree", () => {
    const recorder = new Recorder("test-capability", "Test capability", allowlist);
    const beforeState = mockScreenState("http://localhost:3000/search");
    const afterState = mockScreenState("http://localhost:3000/search?q=12345", [
      { role: "link", name: "12345" },
      { role: "table", name: "Search Results" },
    ]);

    recorder.recordAction(
      { type: "type", target: { role: "textbox", name: "Member ID" }, value: "12345" },
      beforeState,
      afterState,
      "success"
    );

    const artifact = recorder.finalize([], [], { outputsExtracted: true });
    expect(artifact.steps[0].checkpoint).toBeDefined();
    // Checkpoint should reference elements from the after-state
    expect(artifact.steps[0].checkpoint?.anyOf).toBeDefined();
  });

  it("generates a guard from the before-state for non-first steps", () => {
    const recorder = new Recorder("test-capability", "Test capability", allowlist);

    // Step 1: navigate
    recorder.recordAction(
      { type: "navigate", value: "http://localhost:3000/search" },
      mockScreenState("http://localhost:3000/"),
      mockScreenState("http://localhost:3000/search", [{ role: "textbox", name: "Member ID" }]),
      "success"
    );

    // Step 2: type (has a guard from the before-state)
    recorder.recordAction(
      { type: "type", target: { role: "textbox", name: "Member ID" }, value: "12345" },
      mockScreenState("http://localhost:3000/search", [{ role: "textbox", name: "Member ID" }]),
      mockScreenState("http://localhost:3000/search?q=12345", [{ role: "link", name: "12345" }]),
      "success"
    );

    const artifact = recorder.finalize([], [], { outputsExtracted: true });
    expect(artifact.steps).toHaveLength(2);
    // Step 2 should have a guard from the before-state
    expect(artifact.steps[1].guard).toBeDefined();
  });

  it("records extract actions with output mapping", () => {
    const recorder = new Recorder("test-capability", "Test capability", allowlist);
    const beforeState = mockScreenState("http://localhost:3000/detail?id=12345", [
      { role: "heading", name: "Member Detail - John A. Smith" },
    ]);
    const afterState = mockScreenState("http://localhost:3000/detail?id=12345", [
      { role: "heading", name: "Member Detail - John A. Smith" },
    ]);

    recorder.recordAction(
      { type: "extract", target: { role: "heading", name: "Member Detail - John A. Smith" }, output: "memberName" },
      beforeState,
      afterState,
      "success"
    );

    const artifact = recorder.finalize(
      [],
      [{ name: "memberName", type: "string" }],
      { outputsExtracted: true }
    );
    expect(artifact.steps[0].action).toBe("extract");
    expect(artifact.steps[0].output).toBe("memberName");
  });

  it("preserves frame path in locators", () => {
    const recorder = new Recorder("test-capability", "Test capability", allowlist);
    const beforeState = mockScreenState("http://localhost:3000/search");
    const afterState: ScreenState = {
      ...mockScreenState("http://localhost:3000/search"),
      axTree: [{ role: "textbox", name: "Member ID", framePath: ["mainFrame"] }],
    };

    recorder.recordAction(
      { type: "type", target: { role: "textbox", name: "Member ID", framePath: ["mainFrame"] }, value: "12345" },
      beforeState,
      afterState,
      "success"
    );

    const artifact = recorder.finalize([], [], { outputsExtracted: true });
    expect(artifact.steps[0].target.framePath).toEqual(["mainFrame"]);
  });

  it("produces a valid CapabilityArtifact with all required fields", () => {
    const recorder = new Recorder("lookup-member-balance", "Look up a member's balance", allowlist);

    recorder.recordAction(
      { type: "navigate", value: "http://localhost:3000/search" },
      mockScreenState("http://localhost:3000/"),
      mockScreenState("http://localhost:3000/search", [{ role: "textbox", name: "Member ID" }]),
      "success"
    );

    const artifact = recorder.finalize(
      [{ name: "memberId", type: "string", required: true }],
      [{ name: "savingsBalance", type: "string" }],
      { outputsExtracted: true }
    );

    expect(artifact.schemaVersion).toBe("1.0");
    expect(artifact.capability).toBe("lookup-member-balance");
    expect(artifact.description).toBe("Look up a member's balance");
    expect(artifact.surface.type).toBe("web");
    expect(artifact.params).toHaveLength(1);
    expect(artifact.outputs).toHaveLength(1);
    expect(artifact.allowlist).toEqual(allowlist);
    expect(artifact.steps).toHaveLength(1);
    expect(artifact.checkpoint).toBeDefined();
    expect(artifact.metadata.recordedAt).toBeTruthy();
  });
});
