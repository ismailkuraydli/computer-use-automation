import { describe, it, expect } from "vitest";
import { SafetyGuard } from "./safety-guard.js";
import type { AllowlistConfig, ActionType } from "../artifact/types.js";
import type { Action } from "../surface/types.js";

const baseAllowlist: AllowlistConfig = {
  permittedDomains: ["localhost"],
  permittedUrlPatterns: ["/search*", "/detail*", "/new-account*"],
  permittedActions: ["navigate", "click", "type", "extract", "wait"],
  riskyActions: ["submit"],
  irreversibleActions: ["delete" as ActionType],
};

describe("SafetyGuard", () => {
  // AC3: Given an allowlist that permits only /search routes, when the agent
  // attempts to navigate to /admin, then SafetyGuard blocks the action.
  it("blocks navigation to URLs not in the allowlist", () => {
    const guard = new SafetyGuard(baseAllowlist);
    const action: Action = { type: "navigate", value: "http://localhost:3000/admin" };

    const result = guard.check(action, "http://localhost:3000/search");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not permitted");
  });

  it("allows navigation to URLs matching the allowlist patterns", () => {
    const guard = new SafetyGuard(baseAllowlist);
    const action: Action = { type: "navigate", value: "http://localhost:3000/search?q=12345" };

    const result = guard.check(action, "http://localhost:3000/search");
    expect(result.allowed).toBe(true);
  });

  it("blocks navigation to non-permitted domains", () => {
    const guard = new SafetyGuard(baseAllowlist);
    const action: Action = { type: "navigate", value: "http://evil.com/search" };

    const result = guard.check(action, "http://localhost:3000/search");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("domain");
  });

  // AC4: Given a risky action (submit), when the agent attempts it, then
  // SafetyGuard flags it in evidence but allows execution.
  it("flags risky actions but allows them", () => {
    const guard = new SafetyGuard(baseAllowlist);
    const action: Action = {
      type: "submit",
      target: { role: "button", name: "Continue" },
    };

    const result = guard.check(action, "http://localhost:3000/new-account?id=12345");
    expect(result.allowed).toBe(true);
    expect(result.classification).toBe("risky");
    expect(result.flagged).toBe(true);
  });

  // AC5: Given an irreversible action (delete), when the agent attempts it,
  // then SafetyGuard blocks it and routes to escalation.
  it("blocks irreversible actions and routes to escalation", () => {
    const guard = new SafetyGuard(baseAllowlist);
    const action: Action = {
      type: "delete" as ActionType,
      target: { role: "button", name: "Delete Account" },
    };

    const result = guard.check(action, "http://localhost:3000/detail?id=12345");
    expect(result.allowed).toBe(false);
    expect(result.classification).toBe("irreversible");
    expect(result.escalate).toBe(true);
  });

  it("classifies safe actions as safe", () => {
    const guard = new SafetyGuard(baseAllowlist);
    const action: Action = {
      type: "click",
      target: { role: "button", name: "Search" },
    };

    const result = guard.check(action, "http://localhost:3000/search");
    expect(result.allowed).toBe(true);
    expect(result.classification).toBe("safe");
    expect(result.flagged).toBe(false);
  });

  it("blocks action types not in the allowlist", () => {
    const allowlist: AllowlistConfig = {
      permittedDomains: ["localhost"],
      permittedUrlPatterns: ["/search*"],
      permittedActions: ["navigate", "click"],
      // No risky or irreversible — submit not permitted at all
    };
    const guard = new SafetyGuard(allowlist);
    const action: Action = {
      type: "type",
      target: { role: "textbox", name: "Member ID" },
      value: "12345",
    };

    const result = guard.check(action, "http://localhost:3000/search");
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("not permitted");
  });

  it("matches URL patterns with wildcards", () => {
    const guard = new SafetyGuard(baseAllowlist);

    // /detail?id=12345 should match /detail/*
    const r1 = guard.check({ type: "navigate", value: "http://localhost:3000/detail?id=12345" }, "");
    expect(r1.allowed).toBe(true);

    // /search?q=12345 should match /search*
    const r2 = guard.check({ type: "navigate", value: "http://localhost:3000/search?q=12345" }, "");
    expect(r2.allowed).toBe(true);
  });
});
