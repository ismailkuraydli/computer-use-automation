import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { CapabilityCatalog } from "./capability-catalog.js";
import { lookupSavingsBalance, openSubAccount } from "../scenarios/mock-app-artifacts.js";
import type { CapabilityArtifact } from "../artifact/types.js";

let dir: string;

function save(artifact: CapabilityArtifact, version: number): void {
  const file = path.join(dir, artifact.capability, `v${version}.json`);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ ...artifact, artifactVersion: version }));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "catalog-"));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("CapabilityCatalog", () => {
  it("lists every capability with name, description, typed params and outputs (latest version)", () => {
    save(lookupSavingsBalance("http://localhost:3000"), 1);
    save({ ...lookupSavingsBalance("http://localhost:3000"), description: "newer" }, 2);
    save(openSubAccount("http://localhost:3000"), 1);

    const list = new CapabilityCatalog(dir).list();

    expect(list.map((c) => c.name)).toEqual(["lookup-savings-balance", "open-sub-account"]);
    expect(list[0]).toMatchObject({
      name: "lookup-savings-balance",
      description: "newer",
      version: 2,
      app: "keystone-cu",
      irreversible: false,
      outputs: [{ name: "savingsBalance", type: "string" }],
      params: {
        type: "object",
        properties: { memberId: { type: "string" } },
        required: ["memberId"],
        additionalProperties: false,
      },
    });
    expect(list[1].irreversible).toBe(true);
  });

  it("skips files that are not valid artifacts instead of failing the whole catalog", () => {
    save(lookupSavingsBalance("http://localhost:3000"), 1);
    mkdirSync(path.join(dir, "broken"));
    writeFileSync(path.join(dir, "broken", "v1.json"), "{not json");

    expect(new CapabilityCatalog(dir).list().map((c) => c.name)).toEqual(["lookup-savings-balance"]);
  });

  it("returns an empty list when the artifacts directory does not exist", () => {
    expect(new CapabilityCatalog(path.join(dir, "missing")).list()).toEqual([]);
  });

  it("finds a capability by name, optionally at a version, and rejects unsafe names", () => {
    save(lookupSavingsBalance("http://localhost:3000"), 1);
    save(lookupSavingsBalance("http://localhost:3000"), 2);
    const catalog = new CapabilityCatalog(dir);

    expect(catalog.get("lookup-savings-balance")?.artifactVersion).toBe(2);
    expect(catalog.get("lookup-savings-balance", 1)?.artifactVersion).toBe(1);
    expect(catalog.get("nope")).toBeNull();
    expect(catalog.get("../etc")).toBeNull();
  });
});

describe("CapabilityCatalog.validateParams", () => {
  const artifact = {
    ...lookupSavingsBalance("http://localhost:3000"),
    params: [
      { name: "memberId", type: "string" as const, required: true },
      { name: "limit", type: "number" as const, required: false },
      { name: "includeClosed", type: "boolean" as const, required: false },
    ],
  };

  it("accepts correctly typed params", () => {
    expect(CapabilityCatalog.validateParams(artifact, { memberId: "12345", limit: 5, includeClosed: false })).toEqual([]);
  });

  it("reports missing, mistyped and unknown params", () => {
    const errors = CapabilityCatalog.validateParams(artifact, { limit: "five", colour: "red" });

    expect(errors).toEqual([
      'missing required param "memberId"',
      'param "limit" must be a number',
      'unknown param "colour" (expected: memberId, limit, includeClosed)',
    ]);
  });
});
