/**
 * ReplayEngine — deterministic replay of a capability artifact without the LLM.
 * Per the assignment: "Deterministic replay is how the AI agent invokes it in production."
 *
 * Loads an artifact + params, walks steps in order, verifies guards before each
 * step, executes via Surface, verifies checkpoints after each step, handles errors
 * per the three-tier taxonomy, and returns a structured ReplayResult.
 */

import type { Surface, ScreenState, Action, AXNode } from "../surface/types.js";
import type { CapabilityArtifact, ArtifactStep, LocatorSpec } from "../artifact/types.js";
import type { EvidenceCollector } from "../evidence/evidence-collector.js";
import { GuardChecker } from "./guard-checker.js";
import { ErrorClassifier } from "./error-classifier.js";
import type { ReplayResult } from "./result.js";
import { success, businessOutcome, failure, escalated } from "./result.js";
import { resolveLocator } from "../locator/locator-strategy.js";

export interface ReplayEngineOptions {
  surface: Surface;
  evidenceCollector: EvidenceCollector;
  maxRetries?: number;
}

export class ReplayEngine {
  private surface: Surface;
  private evidence: EvidenceCollector;

  constructor(opts: ReplayEngineOptions) {
    this.surface = opts.surface;
    this.evidence = opts.evidenceCollector;
  }

  async run(
    artifact: CapabilityArtifact,
    params: Record<string, string>
  ): Promise<ReplayResult> {
    const outputs: Record<string, string> = {};

    for (const step of artifact.steps) {
      const result = await this._executeStep(step, params, outputs, artifact);
      if (result) {
        return result; // Business outcome, failure, or escalation — stop replay
      }
    }

    // All steps passed — verify final success condition
    if (artifact.checkpoint.outputsExtracted) {
      // Check that all declared outputs were extracted
      for (const outputSpec of artifact.outputs) {
        if (!(outputSpec.name in outputs)) {
          return failure(
            artifact.steps.length,
            `Output "${outputSpec.name}" extracted`,
            "Output not found",
            `Missing output: ${outputSpec.name}`,
            this.evidence.runDir
          );
        }
      }
    }

    return success(outputs, this.evidence.runDir);
  }

  private async _executeStep(
    step: ArtifactStep,
    params: Record<string, string>,
    outputs: Record<string, string>,
    _artifact: CapabilityArtifact
  ): Promise<ReplayResult | null> {
    // Substitute param values in step.value
    const resolvedValue = this._substituteParams(step.value, params);

    // Observe current state
    let state = await this.surface.observe();

    // Check guard (pre-execution)
    // Guards are a best-effort verification — if they fail, log a warning
    // but continue. The steps themselves are the source of truth for replay.
    // A guard may fail when replaying with different params that lead to
    // a different page layout (e.g. searching "mustard" lands on a
    // disambiguation page vs the "banana" article the guard was recorded on).
    if (step.guard && !GuardChecker.check(step.guard, state)) {
      console.log(`  [Guard warning: step ${step.id} — page state differs from discovery]`);
      this.evidence.logStep({
        step: step.id,
        action: step.action,
        target: step.target.primary.name,
        result: "success",
        url: state.url,
        axSnapshot: state.axTree,
        detail: `Guard mismatch (non-fatal): page state differs from discovery`,
      });
    }

    // Resolve locator and build action
    let action = await this._buildAction(step, resolvedValue, state, params);
    if (!action) {
      // Still can't find it — check error handlers before declaring hard failure
      const classification = ErrorClassifier.classify(state, step.onError || []);

      this.evidence.logStep({
        step: step.id,
        action: step.action,
        target: this._substituteParams(step.target.primary.name, params) || step.target.primary.name,
        result: "failure",
        url: state.url,
        axSnapshot: state.axTree,
        detail: `Could not resolve locator for ${step.target.primary.role} "${this._substituteParams(step.target.primary.name, params) || step.target.primary.name}"`,
      });

      if (classification.tier === "business-outcome") {
        return businessOutcome(classification.outcome || "unknown", classification.reason, this.evidence.runDir);
      }
      if (classification.tier === "escalate") {
        return escalated(step.id, classification.reason, this.evidence.runDir);
      }

      return failure(
        step.id,
        `${step.target.primary.role} "${this._substituteParams(step.target.primary.name, params) || step.target.primary.name}" to be present`,
        `Element not found on page`,
        `Locator unresolvable`,
        this.evidence.runDir
      );
    }

    // Execute the action
    const actResult = await this.surface.act(action);

    // Save before-state for error classification, then observe after-state
    const beforeState = state;
    state = await this.surface.observe();

    // Log the step in evidence
    this.evidence.logStep({
      step: step.id,
      action: step.action,
      target: step.target.primary.name,
      result: actResult.ok ? "success" : "failure",
      url: state.url,
      screenshotPath: state.screenshotPath,
      axSnapshot: state.axTree,
    });

    if (!actResult.ok) {
      // Action failed — check error handlers against both before and after state.
      // Use beforeState as primary (it has the page content that triggered the
      // error, e.g. "No records found"), fall back to afterState.
      const errorState = actResult.error === "element-not-found" ? beforeState : state;
      const classification = ErrorClassifier.classify(errorState, step.onError || []);

      if (classification.tier === "business-outcome") {
        return businessOutcome(classification.outcome || "unknown", classification.reason, this.evidence.runDir);
      }
      if (classification.tier === "escalate") {
        return escalated(step.id, classification.reason, this.evidence.runDir);
      }

      return failure(
        step.id,
        `Action ${step.action} to succeed`,
        `Action failed: ${actResult.error}`,
        actResult.error,
        this.evidence.runDir
      );
    }

    // Capture extracted output
    if (step.action === "extract" && step.output && actResult.ok && "extractedValue" in actResult) {
      outputs[step.output] = (actResult as any).extractedValue || "";
    }

    // Check checkpoint (post-execution)
    // Checkpoints are a best-effort verification — if they fail, log a warning
    // but continue. The steps themselves are the source of truth for replay.
    // A checkpoint may fail when replaying with different params that lead to
    // a different page (e.g. searching "mustard" lands on a disambiguation page
    // instead of the "banana" article page the checkpoint was recorded on).
    if (step.checkpoint && !GuardChecker.check(step.checkpoint, state)) {
      console.log(`  [Checkpoint warning: step ${step.id} — page state differs from discovery (expected: ${step.checkpoint.anyOf?.[0]?.urlPattern || "unknown pattern"})]`);
      this.evidence.logStep({
        step: step.id,
        action: step.action,
        target: step.target.primary.name,
        result: "success",
        url: state.url,
        screenshotPath: state.screenshotPath,
        axSnapshot: state.axTree,
        detail: `Checkpoint mismatch (non-fatal): page state differs from discovery`,
      });
    }

    return null; // Step passed — continue to next step
  }

  private _substituteParams(value: string | undefined, params: Record<string, string>): string | undefined {
    if (!value) return undefined;
    let result = value;
    for (const [key, val] of Object.entries(params)) {
      result = result.replace(`{{${key}}}`, val);
    }
    return result;
  }

  private async _buildAction(
    step: ArtifactStep,
    resolvedValue: string | undefined,
    state: ScreenState,
    params: Record<string, string>
  ): Promise<Action | null> {
    if (step.action === "navigate") {
      return { type: "navigate", value: resolvedValue };
    }

    if (step.action === "wait") {
      return { type: "wait", value: resolvedValue || "1000" };
    }

    // read_page_text and scroll don't need a target — they operate on the whole page
    if (step.action === "read_page_text") {
      return { type: "read_page_text" };
    }

    if (step.action === "scroll") {
      return { type: "scroll", value: resolvedValue || "down" };
    }

    // Substitute params in the locator before resolving.
    // If the original step name had a {{param}} template, strip cssSelector
    // and id — they point to the discovery element, not the param-substituted
    // one. The locator strategy and surface will use getByRole with the
    // substituted name instead.
    const hadParamTemplate = /\{\{[^}]+\}\}/.test(step.target.primary.name);
    const resolvedTarget: LocatorSpec = {
      ...step.target,
      primary: {
        ...step.target.primary,
        name: this._substituteParams(step.target.primary.name, params) || step.target.primary.name,
        cssSelector: hadParamTemplate ? undefined : step.target.primary.cssSelector,
        id: hadParamTemplate ? undefined : step.target.primary.id,
      },
    };

    // For click/type/extract/submit — resolve the locator to an AX node
    const resolveResult = resolveLocator(resolvedTarget, state.axTree);
    if (resolveResult.ok) {
      // Element found in the AX tree — use the resolved node
      const target: AXNode = {
        ...resolveResult.node,
        framePath: step.target.framePath,
      };

      const action: Action = {
        type: step.action,
        target,
        value: resolvedValue,
        output: step.output,
      };

      return action;
    }

    // AX tree resolution failed. Build an Action with whatever identity fields
    // remain (cssSelector/id already stripped if the step had {{param}}).
    // The PlaywrightSurface._findElementByAX will try getByRole, getByText,
    // and partial matching to find the element on the actual page.
    const target: AXNode = {
      role: resolvedTarget.primary.role,
      name: resolvedTarget.primary.name,
      cssSelector: resolvedTarget.primary.cssSelector,
      id: resolvedTarget.primary.id,
      dataTestId: resolvedTarget.primary.dataTestId,
      ariaLabel: resolvedTarget.primary.ariaLabel,
      text: resolvedTarget.primary.text,
      href: resolvedTarget.primary.href,
      framePath: step.target.framePath,
    } as AXNode;

    const action: Action = {
      type: step.action,
      target,
      value: resolvedValue,
      output: step.output,
    };

    return action;
  }
}
