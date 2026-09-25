import { describe, it, expect } from "vitest";
import { ErrorClassifier } from "./error-classifier.js";
import type { ScreenState } from "../surface/types.js";
import type { ErrorHandler } from "../artifact/types.js";
import type { Interstitial } from "../artifact/profile-types.js";

function state(names: string[], url = "http://localhost:3000/search"): ScreenState {
  return {
    url,
    title: "Keystone",
    axTree: names.map((name) => ({ role: "StaticText", name })),
    domSnapshot: "",
    frameUrls: [],
  };
}

const NOT_FOUND: ErrorHandler = {
  when: { anyOf: [{ textContains: "No records found" }] },
  kind: "business-outcome",
  outcome: "not-found",
  description: "Member does not exist",
};

const SESSION_EXPIRED: ErrorHandler = {
  when: { anyOf: [{ textContains: "Session Expired" }] },
  kind: "escalate",
  description: "Re-authentication needed",
};

describe("ErrorClassifier.classify", () => {
  it("returns the matching condition", () => {
    const match = ErrorClassifier.classify(state(["No records found for Member ID: 99999"]), [SESSION_EXPIRED, NOT_FOUND]);
    expect(match).toBe(NOT_FOUND);
  });

  it("matches text case-insensitively", () => {
    expect(ErrorClassifier.classify(state(["SESSION EXPIRED: please log in"]), [SESSION_EXPIRED])).toBe(SESSION_EXPIRED);
  });

  it("returns the first match when several conditions hold", () => {
    const both = state(["No records found", "Session Expired"]);
    expect(ErrorClassifier.classify(both, [SESSION_EXPIRED, NOT_FOUND])).toBe(SESSION_EXPIRED);
  });

  it("returns null for an unknown state", () => {
    expect(ErrorClassifier.classify(state(["Member Detail - John A. Smith"]), [NOT_FOUND, SESSION_EXPIRED])).toBeNull();
  });
});

describe("ErrorClassifier.interstitial", () => {
  const notice: Interstitial = {
    name: "System Notice",
    when: { anyOf: [{ axContains: [{ role: "button", name: "Acknowledge" }] }] },
    dismiss: { role: "button", name: "Acknowledge" },
  };

  it("detects a known interstitial by its elements", () => {
    const s: ScreenState = { ...state([]), axTree: [{ role: "button", name: "acknowledge" }] };
    expect(ErrorClassifier.interstitial(s, [notice])).toBe(notice);
  });

  it("returns null when none is on screen", () => {
    expect(ErrorClassifier.interstitial(state(["Member Search"]), [notice])).toBeNull();
  });
});
