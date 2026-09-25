/**
 * ReplayEngine — deterministic replay of a capability artifact, no LLM.
 *
 * Every step ends in exactly one of:
 * - its checkpoint holds (the engine waits for it, bounded) → next step;
 * - a known interstitial is on screen → dismiss it and continue;
 * - a known condition matches (step onError, then the app profile) →
 *   business outcome, bounded retry, escalation or hard failure;
 * - unknown blocking UI (overlay, native dialog) → escalate to a human;
 * - anything else → hard failure with expected vs observed.
 * Nothing proceeds on a warning.
 */

import type { Surface, ScreenState, Action, ActionResult } from "../surface/types.js";
import type { ArtifactStep, CapabilityArtifact, ErrorHandler } from "../artifact/types.js";
import { EMPTY_PROFILE, type AppProfile, type Interstitial } from "../artifact/profile-types.js";
import type { EvidenceCollector } from "../evidence/evidence-collector.js";
import { SafetyGuard } from "../safety/safety-guard.js";
import { describeTarget } from "../surface/playwright-resolver.js";
import { GuardChecker } from "./guard-checker.js";
import { ErrorClassifier } from "./error-classifier.js";
import { substitute, substituteDeep, missingParams, type Params } from "./params.js";
import type { ReplayResult } from "./result.js";
import { success, businessOutcome, failure, escalated } from "./result.js";

const CHECKPOINT_TIMEOUT_MS = 10_000;
const CHECKPOINT_POLL_MS = 500;
const MAX_DISMISSALS_PER_STEP = 2;
const DEFAULT_MAX_RETRIES = 1;

/** Surface errors that mean "something unknown is in the way" — a human can clear it. */
const BLOCKING_ERRORS = new Set(["blocked", "unexpected-dialog"]);

export interface ReplayEngineOptions {
  surface: Surface;
  evidenceCollector: EvidenceCollector;
  profile?: AppProfile;
  checkpointTimeoutMs?: number;
}

export interface RunOptions {
  /** The caller confirms the user approved this run's irreversible steps. */
  confirmIrreversible?: boolean;
}

interface StepContext {
  step: ArtifactStep;
  /** From the step's classification or the allowlist — never retried. */
  irreversible: boolean;
  params: Params;
  handlers: ErrorHandler[];
  retries: number;
  dismissals: number;
}

/** Irreversible by the artifact's own classification or by the allowlist's action types. */
function isIrreversible(step: ArtifactStep, safety: SafetyGuard): boolean {
  if (step.classification === "irreversible") return true;
  return safety.check({ type: step.action }, "").classification === "irreversible";
}

export class ReplayEngine {
  private surface: Surface;
  private evidence: EvidenceCollector;
  private profile: AppProfile;
  private checkpointTimeoutMs: number;

  constructor(opts: ReplayEngineOptions) {
    this.surface = opts.surface;
    this.evidence = opts.evidenceCollector;
    this.profile = opts.profile ?? EMPTY_PROFILE;
    this.checkpointTimeoutMs = opts.checkpointTimeoutMs ?? CHECKPOINT_TIMEOUT_MS;
  }

  async run(artifact: CapabilityArtifact, params: Params, opts: RunOptions = {}): Promise<ReplayResult> {
    const missing = missingParams(artifact.params.filter((p) => p.required).map((p) => p.name), params);
    if (missing.length > 0) {
      return failure(0, `params ${missing.join(", ")}`, "missing", "missing-params", this.evidence.runDir);
    }

    const safety = new SafetyGuard(artifact.allowlist);
    const outputs: Record<string, string> = {};
    let state: ScreenState | null = null;

    for (const step of artifact.steps) {
      const blocked = this._checkPolicy(step, params, safety, opts);
      if (blocked) return blocked;

      const ctx: StepContext = {
        step,
        irreversible: isIrreversible(step, safety),
        params,
        handlers: substituteDeep([...(step.onError ?? []), ...this.profile.conditions], params),
        retries: 0,
        dismissals: 0,
      };
      let outcome: { state: ScreenState } | ReplayResult;
      try {
        outcome = await this._runStep(ctx, outputs, state);
      } catch (e) {
        // The surface contract is to report failures, not throw; if it does,
        // stop with a debuggable failure instead of crashing the caller.
        const message = e instanceof Error ? e.message : String(e);
        this._log(step, "failure", `Surface error: ${message}`);
        return failure(step.id, this._expected(step, params), message, "surface-error", this.evidence.runDir);
      }
      if ("status" in outcome) return outcome;
      state = outcome.state;
    }

    return this._verifyCompletion(artifact, params, outputs, state);
  }

  // --- Policy ---

  private _checkPolicy(step: ArtifactStep, params: Params, safety: SafetyGuard, opts: RunOptions): ReplayResult | null {
    const verdict = safety.check(this._buildAction(step, params), "");

    if (isIrreversible(step, safety)) {
      if (opts.confirmIrreversible) return null;
      this._log(step, "failure", "Irreversible step needs caller confirmation");
      return escalated(step.id, `Step ${step.id} (${step.action}) is irreversible and the run was not confirmed`, this.evidence.runDir);
    }
    if (!verdict.allowed) {
      this._log(step, "failure", `Blocked by allowlist: ${verdict.reason}`);
      return failure(step.id, "action permitted by allowlist", verdict.reason ?? "not permitted", "policy-violation", this.evidence.runDir);
    }
    return null;
  }

  // --- One step ---

  private async _runStep(
    ctx: StepContext,
    outputs: Record<string, string>,
    previous: ScreenState | null
  ): Promise<{ state: ScreenState } | ReplayResult> {
    const { step, params } = ctx;
    const action = this._buildAction(step, params);

    // A known interstitial already on screen would block this step's action:
    // dismiss it up front instead of waiting for the action to time out.
    const upfront = previous && ErrorClassifier.interstitial(previous, substituteDeep(this.profile.interstitials, params));
    if (upfront && action.target) {
      ctx.dismissals++;
      const dismissed = await this._dismiss(step, upfront);
      if (!dismissed.ok) {
        return escalated(step.id, `Could not dismiss "${upfront.name}": ${dismissed.error}`, this.evidence.runDir);
      }
    }

    for (;;) {
      const result = await this.surface.act(action);
      const state = result.ok ? await this._awaitCheckpoint(ctx) : await this.surface.observe();
      const met = result.ok && GuardChecker.check(substituteDeep(step.checkpoint, params), state);

      if (met) {
        if (step.output && result.ok) outputs[step.output] = result.extractedValue ?? "";
        this._log(step, "success", undefined, state);
        return { state };
      }

      const detail = result.ok ? "Checkpoint not met" : `${result.error}: ${result.detail ?? ""}`;
      this._log(step, "failure", detail, state);

      const next = await this._recover(ctx, result, state);
      if (next === "retry-action") continue;
      if (next === "recheck") {
        const rechecked = await this._awaitCheckpoint(ctx);
        if (result.ok && GuardChecker.check(substituteDeep(step.checkpoint, params), rechecked)) {
          if (step.output) outputs[step.output] = result.extractedValue ?? "";
          this._log(step, "success", "Checkpoint met after dismissing interstitial", rechecked);
          return { state: rechecked };
        }
        return failure(step.id, this._expected(step, params), "Checkpoint not met after dismissing interstitial", "checkpoint-failed", this.evidence.runDir);
      }
      return next;
    }
  }

  /**
   * Decide what a failed action or unmet checkpoint means. Returns what to
   * do next, or the final result for the caller.
   */
  private async _recover(ctx: StepContext, result: ActionResult, state: ScreenState): Promise<"retry-action" | "recheck" | ReplayResult> {
    const { step, params } = ctx;

    const interstitial = ErrorClassifier.interstitial(state, substituteDeep(this.profile.interstitials, params));
    if (interstitial && ctx.dismissals < MAX_DISMISSALS_PER_STEP) {
      ctx.dismissals++;
      const dismissed = await this._dismiss(step, interstitial);
      if (!dismissed.ok) {
        return escalated(step.id, `Could not dismiss "${interstitial.name}": ${dismissed.error}`, this.evidence.runDir);
      }
      // The action did not happen if it was blocked; otherwise it already ran.
      return result.ok ? "recheck" : "retry-action";
    }

    const condition = ErrorClassifier.classify(state, ctx.handlers);
    if (condition) return this._applyCondition(ctx, condition);

    if (!result.ok && BLOCKING_ERRORS.has(result.error)) {
      return escalated(step.id, `Unknown blocking UI at step ${step.id}: ${result.detail ?? result.error}`, this.evidence.runDir);
    }

    const observed = result.ok ? `Checkpoint not met on ${state.url}` : `${result.error}: ${result.detail ?? ""}`;
    const error = result.ok ? "checkpoint-failed" : result.error;
    return failure(step.id, this._expected(step, params), observed, error, this.evidence.runDir);
  }

  private _applyCondition(ctx: StepContext, condition: ErrorHandler): "retry-action" | ReplayResult {
    const { step } = ctx;
    switch (condition.kind) {
      case "business-outcome":
        return businessOutcome(condition.outcome ?? "unknown", condition.description, this.evidence.runDir);
      case "escalate":
        return escalated(step.id, condition.description, this.evidence.runDir);
      case "hard-failure":
        return failure(step.id, this._expected(step, ctx.params), condition.description, condition.outcome ?? "known-failure", this.evidence.runDir);
      case "retry": {
        if (ctx.irreversible) {
          return escalated(step.id, `${condition.description} — irreversible step is never retried automatically`, this.evidence.runDir);
        }
        if (ctx.retries >= (condition.maxRetries ?? DEFAULT_MAX_RETRIES)) {
          return failure(step.id, this._expected(step, ctx.params), `${condition.description} (retries exhausted)`, "retries-exhausted", this.evidence.runDir);
        }
        ctx.retries++;
        return "retry-action";
      }
    }
  }

  private async _dismiss(step: ArtifactStep, interstitial: Interstitial): Promise<ActionResult> {
    const result = await this.surface.act({ type: "click", target: interstitial.dismiss });
    this._log(step, result.ok ? "success" : "failure", `Dismissed interstitial "${interstitial.name}"`);
    return result;
  }

  /**
   * Poll until the step's checkpoint holds, a known interstitial or
   * condition shows up, or the timeout passes. Returns the last state seen.
   */
  private async _awaitCheckpoint(ctx: StepContext): Promise<ScreenState> {
    const checkpoint = substituteDeep(ctx.step.checkpoint, ctx.params);
    const interstitials = substituteDeep(this.profile.interstitials, ctx.params);
    const deadline = Date.now() + this.checkpointTimeoutMs;

    let state = await this.surface.observe();
    while (
      Date.now() < deadline &&
      !GuardChecker.check(checkpoint, state) &&
      !ErrorClassifier.interstitial(state, interstitials) &&
      !ErrorClassifier.classify(state, ctx.handlers)
    ) {
      await new Promise((r) => setTimeout(r, CHECKPOINT_POLL_MS));
      state = await this.surface.observe();
    }
    return state;
  }

  // --- Completion ---

  private _verifyCompletion(artifact: CapabilityArtifact, params: Params, outputs: Record<string, string>, state: ScreenState | null): ReplayResult {
    const lastStep = artifact.steps[artifact.steps.length - 1].id;
    const { outputsExtracted, ...signature } = substituteDeep(artifact.checkpoint, params);

    if (state && Object.keys(signature).length > 0 && !GuardChecker.matches(signature, state)) {
      return failure(lastStep, "final success condition", `Not met on ${state.url}`, "checkpoint-failed", this.evidence.runDir);
    }
    if (outputsExtracted) {
      const missing = artifact.outputs.filter((o) => !outputs[o.name]).map((o) => o.name);
      if (missing.length > 0) {
        return failure(lastStep, `outputs ${missing.join(", ")}`, "not extracted", "missing-outputs", this.evidence.runDir);
      }
    }
    return success(outputs, this.evidence.runDir);
  }

  // --- Helpers ---

  private _buildAction(step: ArtifactStep, params: Params): Action {
    return {
      type: step.action,
      target: step.target ? substituteDeep(step.target, params) : undefined,
      value: step.value !== undefined ? substitute(step.value, params) : undefined,
      output: step.output,
    };
  }

  private _expected(step: ArtifactStep, params: Params): string {
    const target = step.target ? ` ${describeTarget(substituteDeep(step.target, params))}` : "";
    return step.checkpoint ? `${step.action}${target} then checkpoint` : `${step.action}${target}`;
  }

  private _log(step: ArtifactStep, result: "success" | "failure", detail?: string, state?: ScreenState): void {
    this.evidence.logStep({
      step: step.id,
      action: step.action,
      target: step.target ? describeTarget(step.target) : step.value ?? "",
      result,
      url: state?.url ?? "",
      screenshotPath: state?.screenshotPath,
      axSnapshot: state?.axTree ?? [],
      detail,
    });
  }
}
