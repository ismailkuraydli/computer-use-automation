import { describe, it, expect } from "vitest";
import { canonicalUrlPattern } from "./canonicalize.js";

describe("canonicalUrlPattern", () => {
  it("turns an ID-like path segment into a named placeholder", () => {
    expect(canonicalUrlPattern("http://app.local/member/12345", [])).toBe("/member/:id");
  });

  it("keeps a param value as-is (the recorder templates it to {{param}} afterwards)", () => {
    expect(canonicalUrlPattern("http://app.local/members/23456/accounts", ["23456"])).toBe("/members/23456/accounts");
  });

  it("recognizes UUIDs and long hex IDs, and keeps words", () => {
    expect(canonicalUrlPattern("http://app.local/case/3f2b8c1e-9a4d-4b7e-8f00-1c2d3e4f5a6b/notes", [])).toBe("/case/:id/notes");
    expect(canonicalUrlPattern("http://app.local/doc/a1b2c3d4e5f6", [])).toBe("/doc/:id");
    expect(canonicalUrlPattern("http://app.local/v2/search", [])).toBe("/v2/search");
  });

  it("keeps query keys and param values, and wildcards other query values", () => {
    expect(canonicalUrlPattern("http://app.local/account-action?id=12345&acct=2003004005", ["12345"])).toBe(
      "/account-action?id=12345&acct=*"
    );
  });

  it("returns undefined for something that is not a URL", () => {
    expect(canonicalUrlPattern("not a url", [])).toBeUndefined();
  });
});
