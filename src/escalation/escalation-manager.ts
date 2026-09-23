/**
 * EscalationManager — pause automation, expose live session, resume after human intervention.
 * Per ADR-006: CDP endpoint exposure + control-state machine.
 *
 * The operator UI is mocked (CLI prints CDP URL), but the control-transfer mechanism
 * is real: the state machine enforces transitions, the CDP endpoint exposes the live
 * browser session, and human actions are recorded.
 */

import { ControlState } from "./control-state.js";
import { HumanActionRecorder } from "./human-action-recorder.js";
import { createEscalationRequest, type EscalationRequest, type HumanAction } from "./escalation-request.js";
import type { Surface } from "../surface/types.js";
import type { StateGuard } from "../artifact/types.js";
import type { EvidenceCollector } from "../evidence/evidence-collector.js";
import { GuardChecker } from "../replay/guard-checker.js";

export type OperatorSignal = "done" | "complete" | "abort";

export interface EscalationResult {
  signal: OperatorSignal;
  humanActions: HumanAction[];
  checkpointPassed: boolean;
  escalated: boolean;
}

export class EscalationManager {
  private controlState: ControlState;
  private actionRecorder: HumanActionRecorder;
  private surface: Surface;
  private evidence: EvidenceCollector;
  private currentRequest: EscalationRequest | null = null;

  constructor(surface: Surface, evidence: EvidenceCollector) {
    this.controlState = new ControlState();
    this.actionRecorder = new HumanActionRecorder();
    this.surface = surface;
    this.evidence = evidence;
  }

  get state(): string {
    return this.controlState.current;
  }

  get currentEscalation(): EscalationRequest | null {
    return this.currentRequest;
  }

  /**
   * Escalate: pause automation, expose the live session, create an escalation request.
   * Returns the EscalationRequest with CDP endpoint info.
   */
  async escalate(
    capability: string,
    stepId: number,
    reason: string
  ): Promise<EscalationRequest> {
    // Transition: automation → paused
    if (!this.controlState.transition("paused")) {
      throw new Error(`Cannot escalate from state "${this.controlState.current}"`);
    }

    // Observe current state
    const screenState = await this.surface.observe();

    // Create escalation request
    const request = createEscalationRequest(capability, stepId, screenState, reason);

    // Expose CDP endpoint if the surface supports it
    if (this.surface.exposeSession) {
      const session = await this.surface.exposeSession();
      request.cdpEndpoint = session.endpoint;
      request.token = session.token;
    }

    this.currentRequest = request;

    // Log in evidence
    this.evidence.logStep({
      step: stepId,
      action: "escalate",
      target: reason,
      result: "failure",
      url: screenState.url,
      screenshotPath: screenState.screenshotPath,
      axSnapshot: screenState.axTree,
      detail: `Escalation: ${reason}. CDP endpoint: ${request.cdpEndpoint || "not available"}`,
    });

    return request;
  }

  /**
   * Operator has connected to the live session.
   * Transitions: paused → human.
   */
  operatorConnected(): boolean {
    return this.controlState.transition("human");
  }

  /**
   * Record a human action during escalation.
   */
  recordHumanAction(action: string, target: string, result: "success" | "failure"): void {
    if (this.controlState.current !== "human") {
      throw new Error(`Cannot record human action in state "${this.controlState.current}" — expected "human"`);
    }
    this.actionRecorder.record(action as any, target, result);
  }

  /**
   * Process the operator's signal (done, complete, or abort).
   * Returns the escalation result with human actions and checkpoint verification.
   */
  async processSignal(
    signal: OperatorSignal,
    checkpoint?: StateGuard
  ): Promise<EscalationResult> {
    const humanActions = this.actionRecorder.actions;

    if (signal === "abort") {
      // Transition: human → done (abort)
      this.controlState.transition("done");
      this._logEscalationEvidence(signal, humanActions, false);
      return {
        signal: "abort",
        humanActions,
        checkpointPassed: false,
        escalated: false,
      };
    }

    if (signal === "complete") {
      // Transition: human → done (complete — goal achieved by human)
      this.controlState.transition("done");
      this._logEscalationEvidence(signal, humanActions, true);
      return {
        signal: "complete",
        humanActions,
        checkpointPassed: true,
        escalated: true,
      };
    }

    // Signal: done — verify checkpoint and resume
    // Transition: human → resuming
    this.controlState.transition("resuming");

    // Verify current state against checkpoint
    const currentState = await this.surface.observe();
    const checkpointPassed = checkpoint ? GuardChecker.check(checkpoint, currentState) : true;

    if (checkpointPassed) {
      // Transition: resuming → automation
      this.controlState.transition("automation");
    } else {
      // Transition: resuming → done (checkpoint failed)
      this.controlState.transition("done");
    }

    this._logEscalationEvidence(signal, humanActions, checkpointPassed);

    return {
      signal: "done",
      humanActions,
      checkpointPassed,
      escalated: checkpointPassed,
    };
  }

  /**
   * Get the control state history for evidence.
   */
  getControlStateHistory(): Array<{ from: string; to: string; at: string }> {
    return this.controlState.history;
  }

  private _logEscalationEvidence(
    signal: OperatorSignal,
    humanActions: HumanAction[],
    checkpointPassed: boolean
  ): void {
    this.evidence.writeSummary({
      goal: `Escalation resolved with signal: ${signal}`,
      totalSteps: humanActions.length,
      success: checkpointPassed,
      error: checkpointPassed ? undefined : `Checkpoint failed after human intervention`,
    });
  }
}
