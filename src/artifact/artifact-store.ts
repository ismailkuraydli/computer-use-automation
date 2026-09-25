/**
 * ArtifactStore — saves and loads versioned capability artifacts as JSON files.
 * Per ADR-007: JSON file storage (human-readable, git-versionable).
 * Per ADR-005: redacts PII before writing.
 */

import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from "fs";
import path from "path";
import type { CapabilityArtifact } from "./types.js";
import { toCurrentArtifact } from "./migrate.js";
import { redactPIIInObject } from "../safety/pii-redactor.js";

export class ArtifactStore {
  private baseDir: string;

  constructor(baseDir: string = "./artifacts") {
    this.baseDir = baseDir;
    mkdirSync(baseDir, { recursive: true });
  }

  save(artifact: CapabilityArtifact): string {
    const capabilityDir = path.join(this.baseDir, artifact.capability);
    mkdirSync(capabilityDir, { recursive: true });

    // Determine version — check existing files
    const existing = readdirSync(capabilityDir)
      .filter((f) => f.match(/^v\d+\.json$/))
      .map((f) => parseInt(f.match(/v(\d+)\.json/)![1], 10));
    const nextVersion = existing.length > 0 ? Math.max(...existing) + 1 : 1;

    const versionedArtifact = { ...artifact, artifactVersion: nextVersion };

    // Redact PII before writing
    const redacted = redactPIIInObject(versionedArtifact);

    const filename = `v${nextVersion}.json`;
    const filePath = path.join(capabilityDir, filename);
    writeFileSync(filePath, JSON.stringify(redacted, null, 2));

    return filePath;
  }

  load(capability: string): CapabilityArtifact | null {
    const capabilityDir = path.join(this.baseDir, capability);
    if (!existsSync(capabilityDir)) return null;

    const files = readdirSync(capabilityDir)
      .filter((f) => f.match(/^v\d+\.json$/))
      .sort((a, b) => {
        const av = parseInt(a.match(/v(\d+)/)![1], 10);
        const bv = parseInt(b.match(/v(\d+)/)![1], 10);
        return bv - av; // descending — latest first
      });

    if (files.length === 0) return null;

    return loadArtifactFile(path.join(capabilityDir, files[0]));
  }

  loadVersion(capability: string, version: number): CapabilityArtifact | null {
    const filePath = path.join(this.baseDir, capability, `v${version}.json`);
    if (!existsSync(filePath)) return null;
    return loadArtifactFile(filePath);
  }
}

/** Read, validate and migrate an artifact file to the current schema. */
export function loadArtifactFile(filePath: string): CapabilityArtifact {
  return toCurrentArtifact(JSON.parse(readFileSync(filePath, "utf-8")));
}
