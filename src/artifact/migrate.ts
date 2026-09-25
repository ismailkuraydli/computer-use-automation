/**
 * Load-time validation and v1 → v2 migration for artifact files.
 *
 * Artifact files are external input: they are validated before the replay
 * engine sees them. v1 artifacts are migrated in memory:
 * - target.primary {role, name} + framePath → TargetSpec; positional CSS
 *   selectors and other DOM identity fields are dropped on purpose;
 * - pre-step guards are dropped (the previous step's checkpoint covers them);
 * - handler "fail" → business-outcome, "retry"/"wait" → retry,
 *   "escalate" → escalate; "dismiss" handlers are dropped (interstitials now
 *   live in the app profile).
 */

import {
  ARTIFACT_SCHEMA_VERSION,
  type ArtifactStep,
  type CapabilityArtifact,
  type ConditionKind,
  type ErrorHandler,
  type ScreenSignature,
  type StateGuard,
  type SuccessCondition,
  type TargetSpec,
} from "./types.js";

const TARGETLESS_ACTIONS = new Set(["navigate", "wait", "scroll", "read_page_text"]);

const V1_HANDLER_KINDS: Record<string, ConditionKind | undefined> = {
  fail: "business-outcome",
  retry: "retry",
  wait: "retry",
  escalate: "escalate",
};

type Json = Record<string, unknown>;

export class ArtifactValidationError extends Error {
  constructor(message: string) {
    super(`Invalid artifact: ${message}`);
    this.name = "ArtifactValidationError";
  }
}

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireField(obj: Json, field: string, where: string): unknown {
  if (obj[field] === undefined || obj[field] === null) {
    throw new ArtifactValidationError(`${where} is missing "${field}"`);
  }
  return obj[field];
}

/** Validate an artifact read from disk and migrate it to the current schema. */
export function toCurrentArtifact(raw: unknown): CapabilityArtifact {
  if (!isObject(raw)) throw new ArtifactValidationError("not a JSON object");
  for (const field of ["capability", "surface", "params", "outputs", "steps", "allowlist"]) {
    requireField(raw, field, "artifact");
  }
  if (!Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new ArtifactValidationError("steps must be a non-empty array");
  }

  const version = String(raw.schemaVersion ?? "1.0");
  if (version.startsWith("2.")) return validateV2(raw as unknown as CapabilityArtifact);
  if (version.startsWith("1.")) return migrateV1(raw);
  throw new ArtifactValidationError(`unsupported schemaVersion "${version}"`);
}

function validateV2(artifact: CapabilityArtifact): CapabilityArtifact {
  artifact.steps.forEach((step, i) => {
    const where = `step ${i + 1}`;
    requireField(step as unknown as Json, "action", where);
    if (!TARGETLESS_ACTIONS.has(step.action) && !step.target?.role) {
      throw new ArtifactValidationError(`${where} (${step.action}) needs a target with a role`);
    }
  });
  return artifact;
}

function migrateV1(raw: Json): CapabilityArtifact {
  const steps = (raw.steps as Json[]).map(migrateStep);
  const checkpoint = isObject(raw.checkpoint) ? raw.checkpoint : {};
  const metadata = isObject(raw.metadata) ? raw.metadata : {};

  return validateV2({
    ...(raw as unknown as CapabilityArtifact),
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    steps,
    checkpoint: migrateSuccessCondition(checkpoint),
    metadata: {
      recordedAt: String(metadata.recordedAt ?? ""),
      recordedBy: String(metadata.recordedBy ?? ""),
      migratedFrom: String(raw.schemaVersion ?? "1.0"),
    },
  });
}

function migrateStep(step: Json, index: number): ArtifactStep {
  const action = requireField(step, "action", `step ${index + 1}`) as ArtifactStep["action"];
  const migrated: ArtifactStep = {
    id: typeof step.id === "number" ? step.id : index + 1,
    action,
  };

  if (!TARGETLESS_ACTIONS.has(action)) migrated.target = migrateTarget(step.target);
  if (typeof step.value === "string") migrated.value = step.value;
  if (typeof step.output === "string") migrated.output = step.output;
  if (typeof step.classification === "string") {
    migrated.classification = step.classification as ArtifactStep["classification"];
  }

  const checkpoint = migrateGuard(step.checkpoint);
  if (checkpoint) migrated.checkpoint = checkpoint;

  const onError = Array.isArray(step.onError) ? step.onError.flatMap(migrateHandler) : [];
  if (onError.length > 0) migrated.onError = onError;

  return migrated;
}

function migrateTarget(target: unknown): TargetSpec {
  const primary = isObject(target) && isObject(target.primary) ? target.primary : {};
  const spec: TargetSpec = { role: String(primary.role ?? "unknown") };
  if (typeof primary.name === "string") spec.name = primary.name;
  if (isObject(target) && Array.isArray(target.framePath) && target.framePath.length > 0) {
    spec.frame = target.framePath.map(String);
  }
  return spec;
}

function migrateSignature(sig: Json): ScreenSignature {
  const out: ScreenSignature = {};
  if (Array.isArray(sig.axContains)) {
    out.axContains = sig.axContains.filter(isObject).map((ref) => ({
      role: String(ref.role),
      name: String(ref.name),
    }));
  }
  if (typeof sig.urlPattern === "string") out.urlPattern = sig.urlPattern;
  if (typeof sig.textContains === "string") out.textContains = sig.textContains;
  return out;
}

function migrateGuard(guard: unknown): StateGuard | undefined {
  if (!isObject(guard)) return undefined;
  const out: StateGuard = {};
  if (Array.isArray(guard.anyOf)) out.anyOf = guard.anyOf.filter(isObject).map(migrateSignature);
  if (Array.isArray(guard.allOf)) out.allOf = guard.allOf.filter(isObject).map(migrateSignature);
  return out.anyOf || out.allOf ? out : undefined;
}

function migrateSuccessCondition(checkpoint: Json): SuccessCondition {
  return {
    ...migrateSignature(checkpoint),
    ...(checkpoint.outputsExtracted === true ? { outputsExtracted: true } : {}),
  };
}

function migrateHandler(handler: unknown): ErrorHandler[] {
  if (!isObject(handler)) return [];
  const kind = V1_HANDLER_KINDS[String(handler.handler)];
  const when = migrateGuard(handler.when);
  if (!kind || !when) return [];
  return [
    {
      when,
      kind,
      ...(typeof handler.outcome === "string" ? { outcome: handler.outcome } : {}),
      ...(typeof handler.maxRetries === "number" ? { maxRetries: handler.maxRetries } : {}),
      description: String(handler.description ?? kind),
    },
  ];
}
