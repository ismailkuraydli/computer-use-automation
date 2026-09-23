import { describe, it, expect } from "vitest";
import { resolveLocator } from "./locator-strategy.js";
import type { AXNode } from "../surface/types.js";
import type { LocatorSpec } from "./types.js";

// Helper: build a mock AX tree
function mockAXTree(): AXNode[] {
  return [
    {
      role: "textbox",
      name: "Member ID",
      framePath: [],
      children: [],
    },
    {
      role: "button",
      name: "Search",
      framePath: [],
      children: [],
    },
    {
      role: "link",
      name: "Member Search",
      framePath: ["navFrame"],
      children: [],
    },
    {
      role: "textbox",
      name: "Initial Deposit",
      framePath: ["mainFrame"],
      children: [],
    },
    {
      role: "button",
      name: "Continue",
      framePath: ["mainFrame"],
      children: [],
    },
  ];
}

describe("LocatorStrategy", () => {
  // AC2: Given a ScreenState with a textbox labeled "Member ID" inside an iframe,
  // when LocatorStrategy resolves an AX locator with role textbox and name "Member ID",
  // then it returns the correct element handle.

  it("resolves an AX locator by role and name in the main frame", () => {
    const tree = mockAXTree();
    const spec: LocatorSpec = {
      primary: { role: "textbox", name: "Member ID" },
    };

    const result = resolveLocator(spec, tree);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.node.role).toBe("textbox");
      expect(result.node.name).toBe("Member ID");
    }
  });

  it("resolves an AX locator inside a specific frame (iframe)", () => {
    const tree = mockAXTree();
    const spec: LocatorSpec = {
      primary: { role: "textbox", name: "Initial Deposit" },
      framePath: ["mainFrame"],
    };

    const result = resolveLocator(spec, tree);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.node.role).toBe("textbox");
      expect(result.node.name).toBe("Initial Deposit");
      expect(result.node.framePath).toEqual(["mainFrame"]);
    }
  });

  it("resolves an AX locator in navFrame", () => {
    const tree = mockAXTree();
    const spec: LocatorSpec = {
      primary: { role: "link", name: "Member Search" },
      framePath: ["navFrame"],
    };

    const result = resolveLocator(spec, tree);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.node.role).toBe("link");
      expect(result.node.name).toBe("Member Search");
    }
  });

  it("resolves a button by role and name", () => {
    const tree = mockAXTree();
    const spec: LocatorSpec = {
      primary: { role: "button", name: "Search" },
    };

    const result = resolveLocator(spec, tree);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.node.role).toBe("button");
    }
  });

  it("returns not-found when no element matches the AX locator", () => {
    const tree = mockAXTree();
    const spec: LocatorSpec = {
      primary: { role: "textbox", name: "Non-existent Field" },
    };

    const result = resolveLocator(spec, tree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not-found");
    }
  });

  it("returns not-found when element exists but in wrong frame", () => {
    const tree = mockAXTree();
    const spec: LocatorSpec = {
      primary: { role: "textbox", name: "Initial Deposit" },
      framePath: [],  // Looking in main frame, but it's in mainFrame
    };

    const result = resolveLocator(spec, tree);
    // Initial Deposit is in mainFrame, not the main frame
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("not-found");
    }
  });

  it("returns ambiguous when multiple elements match the same role+name in the same frame", () => {
    const tree: AXNode[] = [
      { role: "textbox", name: "Amount", framePath: [] },
      { role: "textbox", name: "Amount", framePath: [] },
    ];
    const spec: LocatorSpec = {
      primary: { role: "textbox", name: "Amount" },
    };

    const result = resolveLocator(spec, tree);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("ambiguous");
    }
  });

  it("resolves correctly when elements with same name exist in different frames", () => {
    const tree: AXNode[] = [
      { role: "textbox", name: "Search", framePath: [] },
      { role: "textbox", name: "Search", framePath: ["otherFrame"] },
    ];
    const spec: LocatorSpec = {
      primary: { role: "textbox", name: "Search" },
      framePath: ["otherFrame"],
    };

    const result = resolveLocator(spec, tree);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.node.framePath).toEqual(["otherFrame"]);
    }
  });

  it("matches by description when name alone is ambiguous (future enhancement)", () => {
    // Two textboxes with the same name but different descriptions
    const tree: AXNode[] = [
      { role: "textbox", name: "Amount", description: "primary", framePath: [] },
      { role: "textbox", name: "Amount", description: "secondary", framePath: [] },
    ];
    const spec: LocatorSpec = {
      primary: { role: "textbox", name: "Amount", description: "primary" },
    };

    const result = resolveLocator(spec, tree);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.node.description).toBe("primary");
    }
  });
});
