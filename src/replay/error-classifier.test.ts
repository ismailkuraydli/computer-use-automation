import { describe, it, expect } from "vitest";
import { ErrorClassifier } from "./error-classifier.js";
import type { ScreenState, AXNode } from "../surface/types.js";
import type { ErrorHandler } from "../artifact/types.js";

function mockState(url: string, axTree: AXNode[] = [], domSnapshot: string = ""): ScreenState {
  return { url, title: "Test", axTree, domSnapshot, frameUrls: [url] };
}

describe("ErrorClassifier", () => {
  // AC3: Given a replay where the page shows "No records found", when ErrorClassifier
  // examines the state, then it classifies this as a business outcome (not a failure).
  it("classifies 'No records found' as a business outcome", () => {
    const state = mockState("http://localhost:3000/search?q=99999", [
      { role: "heading", name: "No records found for Member ID: 99999" },
    ]);
    const handlers: ErrorHandler[] = [
      {
        when: { anyOf: [{ textContains: "No records found" }] },
        handler: "fail",
        outcome: "member-not-found",
      },
    ];

    const result = ErrorClassifier.classify(state, handlers);

    expect(result.tier).toBe("business-outcome");
    expect(result.outcome).toBe("member-not-found");
  });

  // AC4: Given a replay where a locator cannot be resolved, when ErrorClassifier
  // examines the state, then it classifies this as a hard failure.
  it("classifies unresolvable locator as a hard failure", () => {
    const state = mockState("http://localhost:3000/search", [
      { role: "button", name: "Search" },
    ]);
    const handlers: ErrorHandler[] = [];

    const result = ErrorClassifier.classify(state, handlers);

    expect(result.tier).toBe("hard-failure");
    expect(result.reason).toContain("no matching error handler");
  });

  // AC5: Given a replay where an unexpected dialog appears (recoverable condition),
  // when the step onError handler matches dismiss, then ErrorClassifier identifies
  // the dismiss handler.
  it("classifies unexpected dialog as recoverable with dismiss handler", () => {
    const state = mockState("http://localhost:3000/search", [
      { role: "alert", name: "Session warning" },
      { role: "textbox", name: "Member ID" },
    ]);
    const handlers: ErrorHandler[] = [
      {
        when: { anyOf: [{ axContains: [{ role: "alert", name: "Session warning" }] }] },
        handler: "dismiss",
        maxRetries: 1,
      },
    ];

    const result = ErrorClassifier.classify(state, handlers);

    expect(result.tier).toBe("recoverable");
    expect(result.handler).toBe("dismiss");
  });

  it("classifies session timeout as hard failure when no handler matches", () => {
    const state = mockState("http://localhost:3000/timeout", [
      { role: "heading", name: "Session Expired: Your session has timed out." },
    ]);
    const handlers: ErrorHandler[] = [
      {
        when: { anyOf: [{ textContains: "validation error" }] },
        handler: "fail",
        outcome: "validation-error",
      },
    ];

    const result = ErrorClassifier.classify(state, handlers);

    expect(result.tier).toBe("hard-failure");
  });

  it("classifies validation error as business outcome when handler matches", () => {
    const state = mockState("http://localhost:3000/new-account-confirm", [
      { role: "heading", name: "Validation Error: Initial deposit must be a positive amount." },
    ]);
    const handlers: ErrorHandler[] = [
      {
        when: { anyOf: [{ textContains: "Validation Error" }] },
        handler: "fail",
        outcome: "validation-error",
      },
    ];

    const result = ErrorClassifier.classify(state, handlers);

    expect(result.tier).toBe("business-outcome");
    expect(result.outcome).toBe("validation-error");
  });

  it("first matching handler wins when multiple handlers match", () => {
    const state = mockState("http://localhost:3000/search", [
      { role: "alert", name: "Error" },
      { role: "textbox", name: "Member ID" },
    ]);
    const handlers: ErrorHandler[] = [
      {
        when: { anyOf: [{ axContains: [{ role: "alert", name: "Error" }] }] },
        handler: "dismiss",
        maxRetries: 1,
      },
      {
        when: { anyOf: [{ textContains: "Error" }] },
        handler: "fail",
        outcome: "error",
      },
    ];

    const result = ErrorClassifier.classify(state, handlers);

    expect(result.tier).toBe("recoverable");
    expect(result.handler).toBe("dismiss"); // First match wins
  });

  it("classifies retry handler as recoverable", () => {
    const state = mockState("http://localhost:3000/search", [
      { role: "heading", name: "Loading..." },
    ]);
    const handlers: ErrorHandler[] = [
      {
        when: { anyOf: [{ textContains: "Loading" }] },
        handler: "wait",
        maxRetries: 3,
      },
    ];

    const result = ErrorClassifier.classify(state, handlers);

    expect(result.tier).toBe("recoverable");
    expect(result.handler).toBe("wait");
  });

  it("classifies escalate handler as requiring escalation", () => {
    const state = mockState("http://localhost:3000/search", [
      { role: "heading", name: "Unexpected system error" },
    ]);
    const handlers: ErrorHandler[] = [
      {
        when: { anyOf: [{ textContains: "Unexpected system error" }] },
        handler: "escalate",
      },
    ];

    const result = ErrorClassifier.classify(state, handlers);

    expect(result.tier).toBe("escalate");
    expect(result.handler).toBe("escalate");
  });
});
