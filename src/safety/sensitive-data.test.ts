import { describe, it, expect } from "vitest";
import { SensitiveDataRedactor } from "./sensitive-data.js";
import type { AXNode } from "../surface/types.js";

const KEYSTONE = {
  fields: ["Name", "SSN", "DOB", "Member"],
  patterns: ["^Member Detail - (.+)$", "^Open New Sub-Account for (.+?) \\(\\d+\\)"],
};

const SEARCH_RESULTS: AXNode[] = [
  { role: "columnheader", name: "Name" },
  { role: "cell", name: "12345", context: { row: ["12345", "John A. Smith"], column: "Member ID" } },
  { role: "cell", name: "John A. Smith", context: { row: ["12345", "John A. Smith"], column: "Name" } },
];

const DETAIL: AXNode[] = [
  { role: "heading", name: "Member Detail - Maria B. Johnson" },
  { role: "cell", name: "1982-07-22", context: { row: ["23456", "1982-07-22"], column: "DOB" } },
  { role: "cell", name: "$8,234.50", context: { row: ["Savings", "$8,234.50"], column: "Balance" } },
];

describe("SensitiveDataRedactor", () => {
  it("learns values from sensitive columns and scrubs them everywhere", () => {
    const r = new SensitiveDataRedactor(KEYSTONE);
    r.learn(SEARCH_RESULTS);

    expect(r.redact("Open New Sub-Account for John A. Smith (12345)")).toBe("Open New Sub-Account for [REDACTED] (12345)");
    expect(r.redact("JOHN A.  SMITH")).toBe("[REDACTED]");
    expect(r.redact("member 12345")).toBe("member 12345");
  });

  it("learns values captured by profile patterns, e.g. a name in a heading", () => {
    const r = new SensitiveDataRedactor(KEYSTONE);
    r.learn(DETAIL);

    expect(r.redact("Member Detail - Maria B. Johnson")).toBe("Member Detail - [REDACTED]");
    expect(r.redact("DOB 1982-07-22")).toBe("DOB [REDACTED]");
    expect(r.redact("Balance $8,234.50")).toBe("Balance $8,234.50");
  });

  it("learns values next to a sensitive label in key/value tables", () => {
    const r = new SensitiveDataRedactor(KEYSTONE);
    r.learn([{ role: "cell", name: "Susan D. Patel (45678)", context: { row: ["Member", "Susan D. Patel (45678)"], label: "Member" } }]);

    expect(r.redact("Member Susan D. Patel (45678)")).toBe("Member [REDACTED]");
  });

  it("still applies the fixed SSN / account patterns, with or without a profile", () => {
    expect(new SensitiveDataRedactor().redact("SSN 123-45-6789 acct 2003004005")).toBe("SSN [REDACTED] acct [REDACTED]");
  });

  it("ignores values too short to scrub safely, and the header cell itself", () => {
    const r = new SensitiveDataRedactor({ fields: ["Name"] });
    r.learn([
      { role: "cell", name: "Al", context: { row: ["Al"], column: "Name" } },
      { role: "columnheader", name: "Name", context: { row: ["Name"], column: "Name" } },
    ]);

    expect(r.redact("Al reviewed the Name field")).toBe("Al reviewed the Name field");
  });

  it("redacts nested objects and lists screenshot masks for learned values", () => {
    const r = new SensitiveDataRedactor(KEYSTONE);
    r.learn(SEARCH_RESULTS);

    expect(r.redactDeep({ steps: [{ target: "link John A. Smith" }] })).toEqual({ steps: [{ target: "link [REDACTED]" }] });
    expect(r.maskTexts).toContain("John A. Smith");
  });
});
