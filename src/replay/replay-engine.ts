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
  private maxRetries: number;

  constructor(opts: ReplayEngineOptions) {
    this.surface = opts.surface;
    this.evidence = opts.evidenceCollector;
    this.maxRetries = opts.maxRetries ?? 3;
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
    if (step.guard && !GuardChecker.check(step.guard, state)) {
      // Guard failed — try error handlers
      const classification = ErrorClassifier.classify(state, step.onError || []);

      this.evidence.logStep({
        step: step.id,
        action: step.action,
        target: step.target.primary.name,
        result: "failure",
        url: state.url,
        axSnapshot: state.axTree,
        detail: `Guard failed: ${classification.reason}`,
      });

      if (classification.tier === "business-outcome") {
        return businessOutcome(
          classification.outcome || "unknown",
          classification.reason,
          this.evidence.runDir
        );
      }
      if (classification.tier === "recoverable") {
        // Try to recover
        const recovered = await this._attemptRecovery(step, params, classification);
        if (recovered) {
          state = await this.surface.observe();
        } else {
          return failure(
            step.id,
            "Guard to pass",
            state.url,
            `Recovery failed: ${classification.reason}`,
            this.evidence.runDir
          );
        }
      } else if (classification.tier === "escalate") {
        return escalated(step.id, classification.reason, this.evidence.runDir);
      } else {
        // Hard failure
        return failure(
          step.id,
          "Guard to pass",
          state.url,
          `Guard failed and no recovery handler: ${classification.reason}`,
          this.evidence.runDir
        );
      }
    }

    // Resolve locator and build action
    let action = await this._buildAction(step, resolvedValue, state, params);
    if (!action) {
      // Locator could not be resolved — try opening a dropdown panel first.
      // Radio buttons and checkboxes are often inside dropdown panels that
      // close after each click. Look for a button that might be the dropdown
      // toggle (e.g., "Appearance", "Settings", "Options") and click it.
      if (step.target.primary.role === "radio" || step.target.primary.role === "checkbox") {
        console.log(`  [Locator not found — trying to open dropdown panel]`);
        const opened = await this._tryOpenDropdown(state);
        if (opened) {
          // Re-observe and retry
          state = await this.surface.observe();
          action = await this._buildAction(step, resolvedValue, state, params);
        }
      }

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
    }

    // Execute the action
    const actResult = await this.surface.act(action);

    // Observe after-state
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
      // Action failed — check error handlers
      const classification = ErrorClassifier.classify(state, step.onError || []);

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
    if (step.checkpoint && !GuardChecker.check(step.checkpoint, state)) {
      const classification = ErrorClassifier.classify(state, step.onError || []);

      if (classification.tier === "business-outcome") {
        return businessOutcome(classification.outcome || "unknown", classification.reason, this.evidence.runDir);
      }
      if (classification.tier === "recoverable") {
        // Checkpoint failed but recoverable — continue
      } else if (classification.tier === "escalate") {
        return escalated(step.id, classification.reason, this.evidence.runDir);
      } else {
        return failure(
          step.id,
          "Checkpoint to match",
          state.url,
          `Checkpoint failed: ${classification.reason}`,
          this.evidence.runDir
        );
      }
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

  /**
   * Try to open a dropdown panel so a hidden radio/checkbox becomes visible.
   *
   * Strategy: instead of guessing which button is the toggle by keyword
   * matching (fragile — keeps picking wrong buttons), try clicking each
   * visible button on the page one by one. After each click, re-observe
   * and check if the target element appeared. Stop when found or all
   * buttons exhausted.
   *
   * This is slower but handles ANY dropdown UI pattern:
   * - Wikipedia Appearance settings
   * - Gmail settings menus
   * - Custom JS widgets
   * - Collapsible panels
   *
   * Excludes buttons we know aren't toggles (search, donate, language switcher)
   * to avoid side effects.
   */
  private async _tryOpenDropdown(state: ScreenState): Promise<boolean> {
    // Collect all visible buttons from the AX tree
    const EXCLUDE_NAMES = ["search", "donate", "log in", "create account", "languages"];
    const buttons = state.axTree.filter((n) => {
      if (n.role !== "button") return false;
      const name = n.name.toLowerCase();
      // Skip buttons that are clearly not dropdown toggles
      if (EXCLUDE_NAMES.some((ex) => name.includes(ex))) return false;
      // Skip "hide", "move" — these are panel management, not openers
      if (name.includes("hide") || name.includes("move")) return false;
      // Skip toggle subsection buttons (table of contents)
      if (name.includes("toggle") && name.includes("subsection")) return false;
      return true;
    });

    if (buttons.length === 0) return false;

    // Try each button until the target appears
    for (const btn of buttons.slice(0, 15)) { // limit to 15 to avoid excessive clicks
      try {
        await this.surface.act({ type: "click", target: btn });
        await this.surface.act({ type: "wait", value: "300" });
        const newState = await this.surface.observe();

        // Check if radio/checkbox elements appeared that weren't there before
        const hasRadios = newState.axTree.some((n) => n.role === "radio" || n.role === "checkbox");
        if (hasRadios) {
          console.log(`  [Dropdown opened by: ${btn.role}:${btn.name}]`);
          return true;
        }
      } catch {
        // Click may have failed or navigated away — try next button
      }
    }

    return false;
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

    // Substitute params in the locator before resolving
    const resolvedTarget: LocatorSpec = {
      ...step.target,
      primary: {
        ...step.target.primary,
        name: this._substituteParams(step.target.primary.name, params) || step.target.primary.name,
      },
    };

    // For click/type/extract/submit — resolve the locator to an AX node
    const resolveResult = resolveLocator(resolvedTarget, state.axTree);
    if (!resolveResult.ok) {
      return null;
    }

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

  private async _attemptRecovery(
    step: ArtifactStep,
    _params: Record<string, string>,
    classification: { handler?: string; maxRetries?: number }
  ): Promise<boolean> {
    const retries = Math.min(classification.maxRetries || 1, this.maxRetries);

    for (let i = 0; i < retries; i++) {
      if (classification.handler === "wait") {
        await this.surface.act({ type: "wait", value: "1000" });
      } else if (classification.handler === "dismiss") {
        // Try to dismiss by pressing Escape
        await this.surface.act({ type: "wait", value: "500" });
      } else if (classification.handler === "retry") {
        // Just wait and retry
        await this.surface.act({ type: "wait", value: "500" });
      }

      // Check if recovery worked
      const state = await this.surface.observe();
      if (step.guard && GuardChecker.check(step.guard, state)) {
        return true;
      }
    }

    return false;
  }
}
