import { describe, it, expect } from "vitest";
import { applyTenantOverlay, rebaseArtifact, validateTenantOverlay, type TenantOverlay } from "./tenant-overlay.js";
import type { CapabilityArtifact } from "./types.js";
import type { AppProfile } from "./profile-types.js";

const BASE = "http://keystone.local:3000";

function artifact(): CapabilityArtifact {
  return {
    schemaVersion: "2.0",
    artifactVersion: 1,
    capability: "lookup-savings-balance",
    description: "Look up a member's savings balance",
    surface: { type: "web", baseUrl: BASE, app: "keystone-cu" },
    params: [{ name: "memberId", type: "string", required: true }],
    outputs: [{ name: "savingsBalance", type: "string" }],
    allowlist: {
      permittedDomains: ["keystone.local"],
      permittedUrlPatterns: ["/search*", "/detail*"],
      permittedActions: ["navigate", "click", "type", "extract"],
    },
    steps: [
      {
        id: 1,
        action: "navigate",
        value: `${BASE}/search`,
        checkpoint: { anyOf: [{ axContains: [{ role: "textbox", name: "Member ID" }] }] },
      },
      { id: 2, action: "type", target: { role: "textbox", name: "Member ID" }, value: "{{memberId}}" },
      {
        id: 3,
        action: "click",
        target: { role: "link", name: "{{memberId}}" },
        checkpoint: { anyOf: [{ urlPattern: "/detail?id={{memberId}}", textContains: "Member Detail" }] },
      },
      { id: 4, action: "extract", target: { role: "cell", row: "Savings", column: "Balance" }, output: "savingsBalance" },
    ],
    checkpoint: { outputsExtracted: true },
    metadata: { recordedAt: "2026-09-25T00:00:00Z", recordedBy: "test" },
  };
}

const PROFILE: AppProfile = {
  schemaVersion: "1.0",
  app: "keystone-cu",
  version: 1,
  interstitials: [{ name: "System Notice", when: { anyOf: [{ textContains: "System Notice" }] }, dismiss: { role: "button", name: "Acknowledge" } }],
  conditions: [{ when: { anyOf: [{ textContains: "No records found" }] }, kind: "business-outcome", outcome: "not-found", description: "none" }],
  sensitive: { fields: ["Name"] },
};

const SUMMIT: TenantOverlay = {
  schemaVersion: "1.0",
  app: "keystone-cu",
  tenant: "summit",
  baseUrl: "http://summit.local:3100",
  labels: { "Member ID": "Account Holder #", Balance: "Available Balance", "Member Detail": "Account Holder Detail" },
  routes: [{ from: "/detail?id={{memberId}}", to: "/members/{{memberId}}" }],
  allowUrlPatterns: ["/members/*"],
  interstitials: [{ name: "Security Reminder", when: { anyOf: [{ textContains: "Security Reminder" }] }, dismiss: { role: "button", name: "Dismiss" } }],
  sensitive: { fields: ["Account Holder"] },
};

describe("applyTenantOverlay", () => {
  it("relabels targets and checkpoints with the tenant's UI text", () => {
    const { artifact: a } = applyTenantOverlay(artifact(), PROFILE, SUMMIT);

    expect(a.steps[0].checkpoint).toEqual({ anyOf: [{ axContains: [{ role: "textbox", name: "Account Holder #" }] }] });
    expect(a.steps[1].target).toEqual({ role: "textbox", name: "Account Holder #" });
    expect(a.steps[3].target).toEqual({ role: "cell", row: "Savings", column: "Available Balance" });
    expect(a.steps[2].checkpoint?.anyOf?.[0].textContains).toBe("Account Holder Detail");
  });

  it("matches labels on whole text only, ignoring case", () => {
    const { artifact: a } = applyTenantOverlay(artifact(), PROFILE, { ...SUMMIT, labels: { "member id": "Account Holder #" } });

    expect(a.steps[1].target?.name).toBe("Account Holder #");
    expect(a.steps[2].target?.name).toBe("{{memberId}}");
  });

  it("rewrites routes and moves the artifact to the tenant's host", () => {
    const { artifact: a } = applyTenantOverlay(artifact(), PROFILE, SUMMIT);

    expect(a.surface.baseUrl).toBe("http://summit.local:3100");
    expect(a.steps[0].value).toBe("http://summit.local:3100/search");
    expect(a.steps[2].checkpoint?.anyOf?.[0].urlPattern).toBe("/members/{{memberId}}");
    expect(a.allowlist.permittedDomains).toContain("summit.local");
    expect(a.allowlist.permittedUrlPatterns).toContain("/members/*");
    expect(a.metadata.tenantOverrides).toBe("summit");
  });

  it("merges the tenant's interstitials, conditions and sensitive fields into the profile, tenant first", () => {
    const { profile } = applyTenantOverlay(artifact(), PROFILE, SUMMIT);

    expect(profile.interstitials.map((i) => i.name)).toEqual(["Security Reminder", "System Notice"]);
    expect(profile.conditions).toHaveLength(1);
    expect(profile.sensitive?.fields).toEqual(["Name", "Account Holder"]);
  });

  it("leaves the inputs untouched", () => {
    const base = artifact();
    const before = JSON.stringify([base, PROFILE]);

    applyTenantOverlay(base, PROFILE, SUMMIT);

    expect(JSON.stringify([base, PROFILE])).toBe(before);
  });

  it("refuses an overlay written for another app", () => {
    expect(() => applyTenantOverlay(artifact(), PROFILE, { ...SUMMIT, app: "other-app" })).toThrow(/other-app/);
  });
});

describe("rebaseArtifact", () => {
  it("moves an artifact to another host: navigation, allowlist and surface", () => {
    const a = rebaseArtifact(artifact(), "https://core.bank.example");

    expect(a.surface.baseUrl).toBe("https://core.bank.example");
    expect(a.steps[0].value).toBe("https://core.bank.example/search");
    expect(a.allowlist.permittedDomains).toEqual(["keystone.local", "core.bank.example"]);
    // same path prefix (none): checkpoint patterns and allowlist patterns unchanged
    expect(a.steps[2].checkpoint?.anyOf?.[0].urlPattern).toBe("/detail?id={{memberId}}");
    expect(a.allowlist.permittedUrlPatterns).toEqual(["/search*", "/detail*"]);
  });

  it("carries a path prefix into navigation, checkpoint patterns and allowlist patterns", () => {
    const a = rebaseArtifact(artifact(), "https://bank.example/portal/");

    expect(a.surface.baseUrl).toBe("https://bank.example/portal");
    expect(a.steps[0].value).toBe("https://bank.example/portal/search");
    expect(a.steps[2].checkpoint?.anyOf?.[0].urlPattern).toBe("/portal/detail?id={{memberId}}");
    expect(a.allowlist.permittedUrlPatterns).toEqual(["/portal/search*", "/portal/detail*"]);
  });

  it("is a no-op for the recorded base URL and leaves the input untouched", () => {
    const base = artifact();
    const before = JSON.stringify(base);

    expect(rebaseArtifact(base, BASE)).toEqual(base);
    rebaseArtifact(base, "https://core.bank.example");
    expect(JSON.stringify(base)).toBe(before);
  });

  it("rejects anything that is not an http(s) URL", () => {
    expect(() => rebaseArtifact(artifact(), "file:///etc")).toThrow(/http/);
    expect(() => rebaseArtifact(artifact(), "not a url")).toThrow(/http/);
  });
});

describe("validateTenantOverlay", () => {
  it("accepts a well-formed overlay", () => {
    expect(validateTenantOverlay(SUMMIT).tenant).toBe("summit");
  });

  it("rejects malformed overlays with a clear message", () => {
    expect(() => validateTenantOverlay({ app: "keystone-cu" })).toThrow(/tenant/);
    expect(() => validateTenantOverlay({ ...SUMMIT, routes: [{ from: "/a" }] })).toThrow(/routes/);
    expect(() => validateTenantOverlay({ ...SUMMIT, baseUrl: "not a url" })).toThrow(/baseUrl/);
  });
});
