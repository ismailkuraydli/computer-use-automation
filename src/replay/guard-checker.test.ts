import { describe, it, expect } from "vitest";
import { GuardChecker } from "./guard-checker.js";
import type { ScreenState, AXNode } from "../surface/types.js";
import type { StateGuard } from "../artifact/types.js";

function mockState(url: string, axTree: AXNode[] = []): ScreenState {
  return { url, title: "Test", axTree, domSnapshot: "", frameUrls: [url] };
}

describe("GuardChecker", () => {
  it("matches when AX tree contains the required elements", () => {
    const state = mockState("http://localhost:3000/search", [
      { role: "textbox", name: "Member ID" },
      { role: "button", name: "Search" },
    ]);
    const guard: StateGuard = {
      anyOf: [{
        axContains: [{ role: "textbox", name: "Member ID" }],
      }],
    };

    expect(GuardChecker.check(guard, state)).toBe(true);
  });

  it("does not match when AX tree lacks required elements", () => {
    const state = mockState("http://localhost:3000/search", [
      { role: "button", name: "Search" },
    ]);
    const guard: StateGuard = {
      anyOf: [{
        axContains: [{ role: "textbox", name: "Member ID" }],
      }],
    };

    expect(GuardChecker.check(guard, state)).toBe(false);
  });

  it("matches URL pattern", () => {
    const state = mockState("http://localhost:3000/search?q=12345", []);
    const guard: StateGuard = {
      anyOf: [{ urlPattern: "/search" }],
    };

    expect(GuardChecker.check(guard, state)).toBe(true);
  });

  it("does not match wrong URL", () => {
    const state = mockState("http://localhost:3000/detail?id=12345", []);
    const guard: StateGuard = {
      anyOf: [{ urlPattern: "/new-account" }],
    };

    expect(GuardChecker.check(guard, state)).toBe(false);
  });

  it("matches textContains", () => {
    const state = mockState("http://localhost:3000/search", [
      { role: "heading", name: "No records found for Member ID: 99999" },
    ]);
    const guard: StateGuard = {
      anyOf: [{ textContains: "No records found" }],
    };

    expect(GuardChecker.check(guard, state)).toBe(true);
  });

  it("anyOf matches if any signature matches", () => {
    const state = mockState("http://localhost:3000/search", [
      { role: "table", name: "Search Results" },
    ]);
    const guard: StateGuard = {
      anyOf: [
        { axContains: [{ role: "alert", name: "No records found" }] },
        { axContains: [{ role: "table", name: "Search Results" }] },
      ],
    };

    expect(GuardChecker.check(guard, state)).toBe(true);
  });

  it("allOf requires all signatures to match", () => {
    const state = mockState("http://localhost:3000/search?q=12345", [
      { role: "textbox", name: "Member ID" },
      { role: "button", name: "Search" },
    ]);
    const guard: StateGuard = {
      allOf: [
        { axContains: [{ role: "textbox", name: "Member ID" }] },
        { urlPattern: "/search" },
      ],
    };

    expect(GuardChecker.check(guard, state)).toBe(true);
  });

  it("allOf fails if any signature does not match", () => {
    const state = mockState("http://localhost:3000/search", [
      { role: "textbox", name: "Member ID" },
    ]);
    const guard: StateGuard = {
      allOf: [
        { axContains: [{ role: "textbox", name: "Member ID" }] },
        { urlPattern: "/detail" },
      ],
    };

    expect(GuardChecker.check(guard, state)).toBe(false);
  });

  it("matches a :placeholder path segment against exactly one segment", () => {
    const guard: StateGuard = { anyOf: [{ urlPattern: "/member/:id" }] };

    expect(GuardChecker.check(guard, mockState("http://localhost:3000/member/12345", []))).toBe(true);
    expect(GuardChecker.check(guard, mockState("http://localhost:3000/member/12345/accounts", []))).toBe(false);
    expect(GuardChecker.check(guard, mockState("http://localhost:3000/member/", []))).toBe(false);
  });

  it("returns true when guard is undefined", () => {
    expect(GuardChecker.check(undefined, mockState("http://localhost:3000", []))).toBe(true);
  });
});
