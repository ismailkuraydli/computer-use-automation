/**
 * AgentLoop — the LLM-driven observe-decide-act loop.
 * Per the assignment: "The model discovers."
 *
 * Takes a goal + target URL, runs the loop against a live Surface using
 * an LLMClient to decide actions. The Recorder captures each action into
 * an artifact. The SafetyGuard enforces the allowlist. The EvidenceCollector
 * logs every step.
 *
 * Stopping conditions: goal met, max steps, timeout, dead-end (LLM error or
 * repeated actions).
 */

import type { LLMClient, LLMRequest, ActionHistoryEntry } from "../llm/types.js";
import type { Surface, Action, ScreenState } from "../surface/types.js";
import type { SafetyGuard } from "../safety/safety-guard.js";
import type { EvidenceCollector } from "../evidence/evidence-collector.js";
import type { Recorder } from "./recorder.js";
import type { CapabilityArtifact, ParamSpec, OutputSpec, SuccessCondition } from "../artifact/types.js";

export interface AgentLoopOptions {
  llmClient: LLMClient;
  surface: Surface;
  safetyGuard: SafetyGuard;
  evidenceCollector: EvidenceCollector;
  recorder: Recorder;
  maxSteps: number;
  timeoutMs: number;
}

export interface AgentLoopResult {
  success: boolean;
  stepsExecuted: number;
  artifact: CapabilityArtifact;
  reason?: string;
  outputs?: Record<string, string>;
}

export class AgentLoop {
  private opts: AgentLoopOptions;

  constructor(opts: AgentLoopOptions) {
    this.opts = opts;
  }

  async run(
    goal: string,
    targetUrl: string,
    params: ParamSpec[] = [],
    outputs: OutputSpec[] = [],
    checkpoint: SuccessCondition = { outputsExtracted: true }
  ): Promise<AgentLoopResult> {
    const { llmClient, surface, safetyGuard, evidenceCollector, recorder } = this.opts;

    const startTime = Date.now();
    const history: ActionHistoryEntry[] = [];
    const extractedOutputs: Record<string, string> = {};
    let stepNumber = 0;
    let lastAction: Action | null = null;
    let repeatCount = 0;

    // Initial navigation to target URL
    const initialAction: Action = { type: "navigate", value: targetUrl };
    const safetyResult = safetyGuard.check(initialAction, targetUrl);
    if (safetyResult.allowed) {
      const beforeState = await surface.observe();
      await surface.act(initialAction);
      const afterState = await surface.observe();
      recorder.recordAction(initialAction, beforeState, afterState, "success");
      evidenceCollector.logStep({
        step: 0,
        action: "navigate",
        target: targetUrl,
        result: "success",
        url: afterState.url,
        screenshotPath: afterState.screenshotPath,
        axSnapshot: afterState.axTree,
      });
      history.push({ step: 0, action: initialAction, result: "success" });
    }

    while (stepNumber < this.opts.maxSteps) {
      // Check timeout
      if (Date.now() - startTime > this.opts.timeoutMs) {
        return this._finish(false, stepNumber, "timeout", recorder, params, outputs, checkpoint, extractedOutputs);
      }

      // Observe current state
      const screenState: ScreenState = await surface.observe();

      // Ask LLM for next action
      const llmRequest: LLMRequest = {
        goal,
        screenState,
        history,
        stepNumber: stepNumber + 1,
      };

      const llmResponse = await llmClient.decide(llmRequest);

      if (!llmResponse.ok) {
        return this._finish(false, stepNumber, `LLM error: ${llmResponse.error}`, recorder, params, outputs, checkpoint, extractedOutputs);
      }

      const action = llmResponse.action;

      // Check for repeated actions (dead-end detection)
      if (lastAction && this._actionsEqual(lastAction, action)) {
        repeatCount++;
        if (repeatCount >= 3) {
          return this._finish(false, stepNumber, "dead-end: repeated same action 3 times", recorder, params, outputs, checkpoint, extractedOutputs);
        }
      } else {
        repeatCount = 0;
      }
      lastAction = action;

      // Check safety
      const safety = safetyGuard.check(action, screenState.url);
      if (!safety.allowed) {
        // Log the blocked action in evidence
        evidenceCollector.logStep({
          step: stepNumber + 1,
          action: action.type,
          target: action.value || action.target?.name || "",
          result: "failure",
          url: screenState.url,
          detail: `Blocked by SafetyGuard: ${safety.reason}`,
        });
        // Don't execute — let the LLM re-plan on the next iteration
        history.push({ step: stepNumber + 1, action, result: "failure", observation: `Blocked: ${safety.reason}` });
        stepNumber++;
        continue;
      }

      // Record before-state
      const beforeState = screenState;

      // Execute the action
      const actResult = await surface.act(action);

      // Record after-state
      const afterState = await surface.observe();

      // Record in artifact
      recorder.recordAction(action, beforeState, afterState, actResult.ok ? "success" : "failure");

      // Log in evidence
      evidenceCollector.logStep({
        step: stepNumber + 1,
        action: action.type,
        target: action.value || action.target?.name || "",
        result: actResult.ok ? "success" : "failure",
        url: afterState.url,
        screenshotPath: afterState.screenshotPath,
        axSnapshot: afterState.axTree,
        detail: safety.flagged ? `Flagged as risky: ${safety.classification}` : undefined,
      });

      // Capture extracted values
      if (action.type === "extract" && actResult.ok && "extractedValue" in actResult && action.output) {
        extractedOutputs[action.output] = actResult.extractedValue || "";
      }

      // Add to history
      history.push({
        step: stepNumber + 1,
        action,
        result: actResult.ok ? "success" : "failure",
      });

      stepNumber++;

      // Check if goal is met
      if (llmResponse.goalMet) {
        return this._finish(true, stepNumber, "goal met", recorder, params, outputs, checkpoint, extractedOutputs);
      }
    }

    // Max steps reached
    return this._finish(false, stepNumber, "max steps reached", recorder, params, outputs, checkpoint, extractedOutputs);
  }

  private _finish(
    success: boolean,
    stepsExecuted: number,
    reason: string,
    recorder: Recorder,
    params: ParamSpec[],
    outputs: OutputSpec[],
    checkpoint: SuccessCondition,
    extractedOutputs: Record<string, string>
  ): AgentLoopResult {
    const artifact = recorder.finalize(params, outputs, checkpoint);

    this.opts.evidenceCollector.writeSummary({
      goal: reason,
      totalSteps: stepsExecuted,
      success,
      outputs: extractedOutputs,
      error: success ? undefined : reason,
    });

    return {
      success,
      stepsExecuted,
      artifact,
      reason,
      outputs: success ? extractedOutputs : undefined,
    };
  }

  private _actionsEqual(a: Action, b: Action): boolean {
    if (a.type !== b.type) return false;
    if (a.value !== b.value) return false;
    if (a.target?.role !== b.target?.role) return false;
    if (a.target?.name !== b.target?.name) return false;
    return true;
  }
}
