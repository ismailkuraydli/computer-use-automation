import { describe, it, expect } from "vitest";
import { normalizeRowScope } from "./agent-loop.js";
import type { AXNode } from "../surface/types.js";

const manage = (row: string[]): AXNode => ({ role: "link", name: "Manage", context: { row, column: "Action" } });
const TREE: AXNode[] = [
  manage(["Checking", "1002003004", "$4,521.33", "Manage"]),
  manage(["Savings", "2003004005", "$12,847.00", "Manage"]),
  { role: "link", name: "23456", context: { row: ["23456", "Maria B. Johnson"] } },
];

describe("normalizeRowScope", () => {
  it("drops a row the target does not need", () => {
    expect(normalizeRowScope({ role: "link", name: "23456", row: "23456 | Maria B. Johnson" }, TREE)).toEqual({ role: "link", name: "23456" });
  });

  it("keeps a row that names one cell", () => {
    expect(normalizeRowScope({ role: "link", name: "Manage", row: "savings" }, TREE)).toEqual({ role: "link", name: "Manage", row: "savings" });
  });

  it("turns a copied (redacted) row line into its identifying cell", () => {
    const copied = { role: "link", name: "Manage", row: "Savings | [REDACTED] | $12,847.00 | Manage" };
    expect(normalizeRowScope(copied, TREE)).toEqual({ role: "link", name: "Manage", row: "Savings" });
  });
});
