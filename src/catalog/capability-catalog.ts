/**
 * CapabilityCatalog — the agent-facing view of saved artifacts: what each
 * capability does, which typed params it takes (as JSON Schema), what it
 * returns, and whether it contains irreversible steps.
 */

import { existsSync, readdirSync, statSync } from "fs";
import path from "path";
import { ArtifactStore } from "../artifact/artifact-store.js";
import type { CapabilityArtifact, OutputSpec, ParamSpec } from "../artifact/types.js";
import { SAFE_NAME } from "../app/workspace.js";

export interface ParamsSchema {
  type: "object";
  properties: Record<string, { type: ParamSpec["type"]; description?: string }>;
  required: string[];
  additionalProperties: false;
}

export interface CapabilitySummary {
  name: string;
  description: string;
  version: number;
  app?: string;
  params: ParamsSchema;
  outputs: OutputSpec[];
  /** Running it needs confirmIrreversible (the user's approval). */
  irreversible: boolean;
  /** Result of the replay right after discovery, if recorded. */
  selfCheck?: string;
}

export class CapabilityCatalog {
  constructor(private readonly artifactsDir: string) {}

  list(): CapabilitySummary[] {
    if (!existsSync(this.artifactsDir)) return [];
    return readdirSync(this.artifactsDir)
      .filter((name) => SAFE_NAME.test(name) && statSync(path.join(this.artifactsDir, name)).isDirectory())
      .sort()
      .flatMap((name) => {
        const artifact = this.get(name);
        return artifact ? [summarize(artifact)] : [];
      });
  }

  /** Latest (or given) version of a capability; null if missing or invalid. */
  get(name: string, version?: number): CapabilityArtifact | null {
    if (!SAFE_NAME.test(name) || !existsSync(this.artifactsDir)) return null;
    try {
      const store = new ArtifactStore(this.artifactsDir);
      return version === undefined ? store.load(name) : store.loadVersion(name, version);
    } catch {
      return null; // unreadable or invalid artifact: not offered to agents
    }
  }

  /** Human-readable problems with the given params; empty when valid. */
  static validateParams(artifact: CapabilityArtifact, input: Record<string, unknown>): string[] {
    const errors: string[] = [];
    for (const spec of artifact.params) {
      const value = input[spec.name];
      if (value === undefined || value === null || value === "") {
        if (spec.required) errors.push(`missing required param "${spec.name}"`);
      } else if (typeof value !== spec.type) {
        errors.push(`param "${spec.name}" must be a ${spec.type}`);
      }
    }
    const known = artifact.params.map((p) => p.name);
    for (const key of Object.keys(input)) {
      if (!known.includes(key)) errors.push(`unknown param "${key}" (expected: ${known.join(", ") || "none"})`);
    }
    return errors;
  }
}

export function summarize(artifact: CapabilityArtifact): CapabilitySummary {
  return {
    name: artifact.capability,
    description: artifact.description,
    version: artifact.artifactVersion,
    ...(artifact.surface.app ? { app: artifact.surface.app } : {}),
    params: paramsSchema(artifact.params),
    outputs: artifact.outputs,
    irreversible: artifact.steps.some(
      (s) => s.classification === "irreversible" || artifact.allowlist.irreversibleActions?.includes(s.action)
    ),
    ...(artifact.metadata.selfCheck ? { selfCheck: artifact.metadata.selfCheck } : {}),
  };
}

function paramsSchema(params: ParamSpec[]): ParamsSchema {
  return {
    type: "object",
    properties: Object.fromEntries(
      params.map((p) => [p.name, { type: p.type, ...(p.description ? { description: p.description } : {}) }])
    ),
    required: params.filter((p) => p.required).map((p) => p.name),
    additionalProperties: false,
  };
}
