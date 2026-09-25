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

import type { LLMClient, LLMRequest, ActionHistoryEntry, SubGoal } from "../llm/types.js";
import type { Surface, Action, ScreenState, TargetSpec, AXNode } from "../surface/types.js";
import { redactPII } from "../safety/pii-redactor.js";
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
    checkpoint: SuccessCondition = { outputsExtracted: true },
    subGoals: SubGoal[] = []
  ): Promise<AgentLoopResult> {
    const { llmClient, surface, safetyGuard, evidenceCollector, recorder } = this.opts;

    const startTime = Date.now();
    const history: ActionHistoryEntry[] = [];
    const extractedOutputs: Record<string, string> = {};
    let stepNumber = 0;
    let lastAction: Action | null = null;
    let repeatCount = 0;
    let pageTextRead = false;

    // Sub-goal tracking
    const completedSubGoals: string[] = [];
    let currentSubGoalIndex = 0;
    const allSubGoals = subGoals.length > 0 ? subGoals : [{ id: "1", description: goal, keywords: [] as string[] }];

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
      const currentSubGoal = allSubGoals[currentSubGoalIndex];

      const llmRequest: LLMRequest = {
        goal,
        screenState,
        history,
        stepNumber: stepNumber + 1,
        outputNames: outputs.map(o => o.name),
        paramNames: params.map(p => p.name),
        subGoals: allSubGoals,
        completedSubGoals,
        currentSubGoal: currentSubGoal?.id,
      };

      const llmResponse = await llmClient.decide(llmRequest);

      // Log the LLM call for debugging
      evidenceCollector.logLLMCall({
        step: stepNumber + 1,
        request: {
          goal,
          screenStateUrl: screenState.url,
          screenStateAxTree: screenState.axTree,
          history: history.map(h => ({ step: h.step, actionType: h.action.type, result: h.result })),
          stepNumber: stepNumber + 1,
        },
        response: {
          ok: llmResponse.ok,
          action: llmResponse.ok ? {
            type: llmResponse.action.type,
            target: llmResponse.action.target,
            value: llmResponse.action.value,
          } : undefined,
          reasoning: llmResponse.ok ? llmResponse.reasoning : undefined,
          goalMet: llmResponse.ok ? llmResponse.goalMet : undefined,
          subGoalComplete: llmResponse.ok ? llmResponse.subGoalComplete : undefined,
          outputComplete: llmResponse.ok ? llmResponse.outputComplete : undefined,
          error: llmResponse.ok ? undefined : llmResponse.error,
        },
        timestamp: new Date().toISOString(),
      });

      if (!llmResponse.ok) {
        return this._finish(false, stepNumber, `LLM error: ${llmResponse.error}`, recorder, params, outputs, checkpoint, extractedOutputs);
      }

      const action = llmResponse.action;

      // Keep the model's row scope only where it is needed, and as one cell.
      if (action.target) {
        action.target = normalizeRowScope(action.target, screenState.axTree, (t) => this.opts.evidenceCollector.redactor.redact(t));
      }

      // Enrich the target with its frame from the AX tree — the LLM doesn't
      // know about frames, but every AX node carries its framePath.
      if (action.target && screenState.axTree.length > 0) {
        const match = screenState.axTree.find(
          (n) => n.role === action.target!.role && n.name === action.target!.name
        );
        if (match && match.framePath && match.framePath.length > 0) {
          action.target = { ...action.target, frame: match.framePath };
        }
      }

      // Check for repeated actions (dead-end detection)
      if (lastAction && this._actionsEqual(lastAction, action)) {
        repeatCount++;
        if (repeatCount >= 3) {
          // Before giving up, try read_page_text once to give the LLM more context
          if (action.type !== "read_page_text" && !pageTextRead) {
            console.log(`  [Dead-end detected — reading page text for more context]`);
            pageTextRead = true;
            const readResult = await this.opts.surface.act({ type: "read_page_text" });
            if (readResult.ok && "extractedValue" in readResult) {
              history.push({
                step: stepNumber + 1,
                action: { type: "read_page_text" },
                result: "success",
                observation: `Page text: ${(readResult as any).extractedValue?.substring(0, 500) || ""}`,
              });
              repeatCount = 0; // Reset — give the LLM another chance with more context
              stepNumber++;
              continue;
            }
          }
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
      recorder.recordAction(action, beforeState, afterState, actResult.ok ? "success" : "failure", llmResponse.expect);

      // Log in evidence
      evidenceCollector.logStep({
        step: stepNumber + 1,
        action: action.type,
        target: action.value || action.target?.name || "",
        result: actResult.ok ? "success" : "failure",
        url: afterState.url,
        screenshotPath: afterState.screenshotPath,
        axSnapshot: afterState.axTree,
        detail: [
          !actResult.ok ? `${actResult.error}: ${actResult.detail ?? ""}` : "",
          safety.flagged ? `Flagged as risky: ${safety.classification}` : "",
        ].filter(Boolean).join("; ") || undefined,
      });

      // Capture extracted output — normalize the output name to match declared outputs
      if (action.type === "extract" && actResult.ok && "extractedValue" in actResult && action.output) {
        const normalize = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
        const knownOutput = outputs.find(o => normalize(o.name) === normalize(action.output!));
        const outputName = knownOutput ? knownOutput.name : action.output;
        const extractedValue = (actResult as any).extractedValue || "";
        // If the output already has a value, append (e.g. extracting multiple books into one output)
        if (extractedOutputs[outputName]) {
          extractedOutputs[outputName] += "\n" + extractedValue;
        } else {
          extractedOutputs[outputName] = extractedValue;
        }
      }

      // Capture read_page_text result as observation in history (not as an output, but available for the LLM)
      if (action.type === "read_page_text" && actResult.ok && "extractedValue" in actResult) {
        // The page text is available in the next observe() — the LLM can see it in the AX tree
        // But also store it so the LLM can reference it via history
        const pageText = (actResult as any).extractedValue || "";
        history.push({
          step: stepNumber + 1,
          action,
          result: "success",
          observation: `Page text (first 200 chars): ${pageText.substring(0, 200)}`,
        });
        stepNumber++;
        continue;
      }

      // Add to history with extracted value if available (for output verification)
      const historyObservation = (action.type === "extract" && actResult.ok && "extractedValue" in actResult)
        ? `Extracted: "${((actResult as any).extractedValue || "").substring(0, 200)}"`
        : undefined;

      history.push({
        step: stepNumber + 1,
        action,
        result: actResult.ok ? "success" : "failure",
        observation: historyObservation,
      });

      stepNumber++;

      // Check if goal is met — only if all sub-goals are complete AND output is verified.
      // A claim of success on a failed action, or with declared outputs still
      // missing, is not accepted: the model sees the failure and continues.
      const outputsMissing = outputs.some((o) => !extractedOutputs[o.name]);
      if (llmResponse.goalMet && (!actResult.ok || outputsMissing)) {
        console.log(`  [Goal not met: ${!actResult.ok ? "last action failed" : "outputs missing"} — continuing]`);
        continue;
      }
      if (llmResponse.goalMet) {
        if (currentSubGoalIndex < allSubGoals.length - 1) {
          // Can't declare goal met — there are remaining sub-goals
          if (llmResponse.subGoalComplete) {
            if (currentSubGoal) completedSubGoals.push(currentSubGoal.id);
            currentSubGoalIndex++;
          }
          continue;
        }

        // All sub-goals complete — check output verification
        if (outputs.length > 0 && llmResponse.outputComplete === false) {
          // Output not complete — LLM says the extracted value doesn't satisfy the goal
          console.log(`  [Output not complete — continuing to extract more]`);
          continue;
        }

        return this._finish(true, stepNumber, "goal met", recorder, params, outputs, checkpoint, extractedOutputs);
      }

      // Check if current sub-goal is complete
      if (llmResponse.subGoalComplete) {
        if (currentSubGoal) {
          completedSubGoals.push(currentSubGoal.id);
        }
        currentSubGoalIndex++;
        if (currentSubGoalIndex < allSubGoals.length) {
          console.log(`  [Sub-goal ${currentSubGoal?.id} complete, advancing to ${allSubGoals[currentSubGoalIndex].id}]`);
        }
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

const normText = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

/**
 * Models often copy the whole row line ("Savings | 2003004005 | ...") or add a
 * row to a target that is already unique. Drop the row when role + name is
 * unique; replace a full-row copy with the row's first other cell.
 */
export function normalizeRowScope(target: TargetSpec, tree: AXNode[], redact: (text: string) => string = redactPII): TargetSpec {
  if (!target.row) return target;
  const { row, ...rest } = target;
  const same = tree.filter((n) => n.role === target.role && (!target.name || normText(n.name) === normText(target.name)));
  if (same.length <= 1) return rest;

  const cells = (n: AXNode) => (n.context?.row ?? []).map(normText);
  if (same.some((n) => cells(n).includes(normText(row)))) return target;

  // The model saw the row redacted, so compare against the redacted form
  const copied = same.find((n) => normText(redact((n.context?.row ?? []).join(" | "))) === normText(row));
  const key = copied?.context?.row?.find((c) => c && normText(c) !== normText(target.name ?? ""));
  return key ? { ...rest, row: key } : target;
}
