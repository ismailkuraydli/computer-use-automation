import { describe, it, expect } from "vitest";
import { loadProfile, validateProfile, ProfileValidationError } from "./profile-store.js";

describe("loadProfile", () => {
  it("loads the Keystone profile", () => {
    const profile = loadProfile("keystone-cu");
    expect(profile.app).toBe("keystone-cu");
    expect(profile.interstitials.map((i) => i.name)).toContain("System Notice");
    expect(profile.conditions.find((c) => c.outcome === "not-found")?.kind).toBe("business-outcome");
  });

  it("returns an empty profile when the artifact names no app", () => {
    expect(loadProfile(undefined)).toMatchObject({ interstitials: [], conditions: [] });
  });

  it("rejects names that could escape the profiles directory", () => {
    expect(() => loadProfile("../package")).toThrow(ProfileValidationError);
  });

  it("rejects conditions with an unknown kind", () => {
    const bad = { app: "x", interstitials: [], conditions: [{ when: {}, kind: "ignore", description: "?" }] };
    expect(() => validateProfile(bad)).toThrow(/invalid kind/);
  });

  it("rejects sensitive patterns that are not valid regexes", () => {
    const bad = { app: "x", interstitials: [], conditions: [], sensitive: { patterns: ["(unclosed"] } };
    expect(() => validateProfile(bad)).toThrow(/not a valid regex/);
  });

  it("declares where Keystone keeps names and dates of birth", () => {
    expect(loadProfile("keystone-cu").sensitive?.fields).toEqual(expect.arrayContaining(["Name", "DOB"]));
  });
});
