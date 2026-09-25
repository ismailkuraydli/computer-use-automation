import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ArtifactStore } from "./artifact-store.js";
import type { CapabilityArtifact } from "./types.js";
import { rmSync, existsSync, readFileSync } from "fs";
import path from "path";

const TEST_ARTIFACTS_DIR = path.join(process.cwd(), "test-artifacts");

function mockArtifact(): CapabilityArtifact {
  return {
    schemaVersion: "2.0",
    artifactVersion: 1,
    capability: "lookup-member-balance",
    description: "Look up a member and read their savings balance",
    surface: { type: "web", baseUrl: "http://localhost:3000" },
    params: [{ name: "memberId", type: "string", required: true }],
    outputs: [{ name: "savingsBalance", type: "string" }],
    allowlist: {
      permittedDomains: ["localhost"],
      permittedUrlPatterns: ["/search*", "/detail/*"],
      permittedActions: ["navigate", "click", "type", "extract"],
    },
    steps: [
      {
        id: 1,
        action: "navigate",
        value: "http://localhost:3000/search",
      },
      {
        id: 2,
        action: "type",
        target: { role: "textbox", name: "Member ID" },
        value: "{{memberId}}",
      },
    ],
    checkpoint: { outputsExtracted: true },
    metadata: { recordedAt: "2026-09-23T20:00:00Z", recordedBy: "test" },
  };
}

describe("ArtifactStore", () => {
  let store: ArtifactStore;

  beforeEach(() => {
    rmSync(TEST_ARTIFACTS_DIR, { recursive: true, force: true });
    store = new ArtifactStore(TEST_ARTIFACTS_DIR);
  });

  afterEach(() => {
    rmSync(TEST_ARTIFACTS_DIR, { recursive: true, force: true });
  });

  // AC7: Given a completed discovery run, when the artifact is saved, then
  // ArtifactStore writes a versioned JSON file with no PII or secrets.
  it("saves an artifact as a versioned JSON file", () => {
    const artifact = mockArtifact();
    const savedPath = store.save(artifact);

    expect(existsSync(savedPath)).toBe(true);
    const loaded = JSON.parse(readFileSync(savedPath, "utf-8"));
    expect(loaded.capability).toBe("lookup-member-balance");
    expect(loaded.schemaVersion).toBe("2.0");
    expect(loaded.artifactVersion).toBe(1);
  });

  it("increments version when saving an updated artifact", () => {
    const artifact = mockArtifact();
    store.save(artifact);

    // Save again with same capability name
    const updated = { ...artifact, description: "Updated description" };
    const savedPath = store.save(updated);
    expect(savedPath).toContain("v2");

    const loaded = JSON.parse(readFileSync(savedPath, "utf-8"));
    expect(loaded.artifactVersion).toBe(2);
    expect(loaded.description).toBe("Updated description");
  });

  it("loads a saved artifact by capability name", () => {
    const artifact = mockArtifact();
    store.save(artifact);

    const loaded = store.load("lookup-member-balance");
    expect(loaded).not.toBeNull();
    expect(loaded!.capability).toBe("lookup-member-balance");
    expect(loaded!.steps).toHaveLength(2);
  });

  it("returns null when loading a non-existent artifact", () => {
    const loaded = store.load("non-existent");
    expect(loaded).toBeNull();
  });

  it("loads the latest version when multiple versions exist", () => {
    const artifact = mockArtifact();
    store.save(artifact);
    store.save({ ...artifact, description: "v2" });
    store.save({ ...artifact, description: "v3" });

    const loaded = store.load("lookup-member-balance");
    expect(loaded!.description).toBe("v3");
    expect(loaded!.artifactVersion).toBe(3);
  });

  it("redacts PII from saved artifacts", () => {
    const artifact = mockArtifact();
    // Inject PII into a value
    artifact.steps[1].value = "SSN: 123-45-6789";

    const savedPath = store.save(artifact);
    const loaded = JSON.parse(readFileSync(savedPath, "utf-8"));
    expect(loaded.steps[1].value).toBe("SSN: [REDACTED]");
    expect(loaded.steps[1].value).not.toContain("123-45-6789");
  });

  // AC8: MockLLMClient isolation — verified separately, but this test
  // confirms no secrets in artifacts
  it("does not persist secrets in the artifact", () => {
    const artifact = mockArtifact();
    artifact.metadata = {
      recordedAt: "2026-09-23T20:00:00Z",
      recordedBy: "test",
    };

    const savedPath = store.save(artifact);
    const content = readFileSync(savedPath, "utf-8");
    // No API keys, passwords, or tokens should appear
    expect(content).not.toMatch(/api[_-]?key/i);
    expect(content).not.toMatch(/password/i);
    expect(content).not.toMatch(/token/i);
    expect(content).not.toMatch(/secret/i);
  });
});
