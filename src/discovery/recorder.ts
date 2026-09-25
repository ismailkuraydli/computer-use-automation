/**
 * Recorder — turns the successful actions of a discovery run into a
 * schema-v2 capability artifact.
 *
 * Failed actions are not recorded: they changed nothing, and the model
 * retries with a different action. Runtime conditions (not found, session
 * expired, notices) are not recorded per step either — they belong to the
 * app profile.
 */

import type { Action, ScreenState } from "../surface/types.js";
import {
  ARTIFACT_SCHEMA_VERSION,
  type AllowlistConfig,
  type ArtifactStep,
  type CapabilityArtifact,
  type OutputSpec,
  type ParamSpec,
  type SuccessCondition,
} from "../artifact/types.js";
import { buildCheckpoint, buildTarget } from "./step-builders.js";
import { parameterizeSteps } from "./parameterize.js";

const MIN_INFERRED_PARAM_LENGTH = 3;

export interface RecorderOptions {
  capability: string;
  description: string;
  allowlist: AllowlistConfig;
  params?: ParamSpec[];
  outputs?: OutputSpec[];
  /** paramName → concrete value used during discovery. */
  paramValues?: Record<string, string>;
  /** Goal text — used to infer param values the plan did not name. */
  goal?: string;
  /** App profile name for the artifact. */
  app?: string;
}

export class Recorder {
  private readonly opts: RecorderOptions;
  private readonly paramValues: Record<string, string>;
  private steps: ArtifactStep[] = [];
  private baseUrl = "";

  constructor(opts: RecorderOptions) {
    this.opts = opts;
    this.paramValues = { ...(opts.paramValues ?? {}) };
  }

  recordAction(
    action: Action,
    beforeState: ScreenState,
    afterState: ScreenState,
    result: "success" | "failure",
    expect?: string
  ): void {
    if (result === "failure") return;

    this._inferParamValue(action);
    if (this.steps.length === 0 && action.type === "navigate" && action.value) {
      this.baseUrl = originOf(action.value);
    }

    const values = Object.values(this.paramValues);
    const target = buildTarget(action, beforeState, values);
    const checkpoint = buildCheckpoint(action, beforeState, afterState, expect, values);
    const classification = this._classify(action);

    this.steps.push({
      id: this.steps.length + 1,
      action: action.type,
      ...(target ? { target } : {}),
      ...(action.value !== undefined ? { value: action.value } : {}),
      ...(action.type === "extract" ? { output: this._outputName(action.output) } : {}),
      ...(checkpoint ? { checkpoint } : {}),
      ...(classification !== "safe" ? { classification } : {}),
    });
  }

  finalize(params: ParamSpec[], outputs: OutputSpec[], checkpoint: SuccessCondition): CapabilityArtifact {
    return {
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      artifactVersion: 1,
      capability: this.opts.capability,
      description: this.opts.description,
      surface: {
        type: "web",
        baseUrl: this.baseUrl,
        ...(this.opts.app ? { app: this.opts.app } : {}),
      },
      params,
      outputs,
      allowlist: this.opts.allowlist,
      steps: parameterizeSteps(this.steps, this.paramValues),
      checkpoint,
      metadata: {
        recordedAt: new Date().toISOString(),
        recordedBy: process.env.USER || "unknown",
      },
    };
  }

  /** Concrete param values used in this run (declared or inferred). */
  get discoveryParams(): Record<string, string> {
    return { ...this.paramValues };
  }

  /** A typed value that appears in the goal fills the first param without a value. */
  private _inferParamValue(action: Action): void {
    const goal = (this.opts.goal ?? "").toLowerCase();
    if (action.type !== "type" || !action.value || action.value.length < MIN_INFERRED_PARAM_LENGTH) return;
    if (!goal.includes(action.value.toLowerCase())) return;
    const free = (this.opts.params ?? []).find((p) => !(p.name in this.paramValues));
    if (free) this.paramValues[free.name] = action.value;
  }

  private _outputName(requested: string | undefined): string | undefined {
    const outputs = this.opts.outputs ?? [];
    if (!requested) return outputs[0]?.name;
    const normalize = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
    return outputs.find((o) => normalize(o.name) === normalize(requested))?.name ?? requested;
  }

  private _classify(action: Action): "safe" | "risky" | "irreversible" {
    if (this.opts.allowlist.irreversibleActions?.includes(action.type)) return "irreversible";
    if (this.opts.allowlist.riskyActions?.includes(action.type)) return "risky";
    return "safe";
  }
}

function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return url;
  }
}
