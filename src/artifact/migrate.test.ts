import { describe, it, expect } from "vitest";
import { toCurrentArtifact, ArtifactValidationError } from "./migrate.js";

function v1Artifact(): Record<string, unknown> {
  return {
    schemaVersion: "1.0",
    artifactVersion: 3,
    capability: "find-top-books-by-genre",
    description: "Find top books",
    surface: { type: "web", baseUrl: "http://goodreads.com" },
    params: [{ name: "genre", type: "string", required: true }],
    outputs: [{ name: "top_books", type: "string" }],
    allowlist: { permittedDomains: ["goodreads.com"], permittedUrlPatterns: ["/*"], permittedActions: ["click"] },
    steps: [
      {
        id: 1,
        action: "navigate",
        target: { primary: { role: "RootWebArea", name: "http://goodreads.com" } },
        value: "http://goodreads.com",
      },
      {
        id: 2,
        action: "click",
        target: {
          primary: { role: "link", name: "{{genre}}", cssSelector: "div > a:nth-of-type(7)", href: "/genres/horror" },
          fallback: { selector: "div > a:nth-of-type(7)" },
          framePath: ["mainFrame"],
        },
        guard: { anyOf: [{ urlPattern: "/" }] },
        checkpoint: { anyOf: [{ urlPattern: "/genres/{{genre}}", axContains: [{ role: "heading", name: "{{genre}}", cssSelector: "h1" }] }] },
        onError: [
          { when: { anyOf: [{ textContains: "No results" }] }, handler: "fail", outcome: "not-found", description: "none" },
          { when: { anyOf: [{ textContains: "Loading" }] }, handler: "wait", maxRetries: 2 },
          { when: { anyOf: [{ textContains: "Popup" }] }, handler: "dismiss" },
        ],
      },
    ],
    checkpoint: { outputsExtracted: true },
    metadata: { recordedAt: "2026-09-23T00:00:00Z", recordedBy: "hermes" },
  };
}

describe("toCurrentArtifact", () => {
  it("migrates v1 targets to semantic targets and drops DOM positions", () => {
    const artifact = toCurrentArtifact(v1Artifact());

    expect(artifact.schemaVersion).toBe("2.0");
    expect(artifact.metadata.migratedFrom).toBe("1.0");
    expect(artifact.steps[0].target).toBeUndefined();
    expect(artifact.steps[1].target).toEqual({ role: "link", name: "{{genre}}", frame: ["mainFrame"] });
  });

  it("keeps checkpoints, drops guards and maps handler kinds", () => {
    const step = toCurrentArtifact(v1Artifact()).steps[1];

    expect(step).not.toHaveProperty("guard");
    expect(step.checkpoint).toEqual({
      anyOf: [{ urlPattern: "/genres/{{genre}}", axContains: [{ role: "heading", name: "{{genre}}" }] }],
    });
    expect(step.onError?.map((h) => h.kind)).toEqual(["business-outcome", "retry"]);
  });

  it("passes a valid v2 artifact through", () => {
    const v2 = { ...v1Artifact(), schemaVersion: "2.0", steps: [{ id: 1, action: "click", target: { role: "button", name: "Go" } }] };
    expect(toCurrentArtifact(v2).steps[0].target).toEqual({ role: "button", name: "Go" });
  });

  it("rejects malformed input with a clear error", () => {
    expect(() => toCurrentArtifact(null)).toThrow(ArtifactValidationError);
    expect(() => toCurrentArtifact({ ...v1Artifact(), steps: [] })).toThrow(/non-empty/);
    expect(() => toCurrentArtifact({ ...v1Artifact(), schemaVersion: "9.0" })).toThrow(/unsupported/);
    const noTarget = { ...v1Artifact(), schemaVersion: "2.0", steps: [{ id: 1, action: "click" }] };
    expect(() => toCurrentArtifact(noTarget)).toThrow(/needs a target/);
  });
});
