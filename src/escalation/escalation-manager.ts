/**
 * EscalationManager — pause automation, hand the live session to a human,
 * take it back.
 *
 * The control-transfer model is real: the state machine says who is in
 * control (automation → paused → human → resuming → automation | done), the
 * human works on the SAME browser session the automation was using, and the
 * surface records what they do. Only the operator UI is minimal: an
 * OperatorChannel (terminal prompt by default) carries the request and the
 * operator's signal.
 */

import { ControlState } from "./control-state.js";
import { HumanActionRecorder } from "./human-action-recorder.js";
import { createEscalationRequest, type EscalationRequest, type HumanAction } from "./escalation-request.js";
import type { Surface } from "../surface/types.js";
import type { StateGuard } from "../artifact/types.js";
import type { EvidenceCollector } from "../evidence/evidence-collector.js";
import { GuardChecker } from "../replay/guard-checker.js";
import type { OperatorChannel } from "./operator-channel.js";

export interface HandoffRequest {
  capability: string;
  stepId: number;
  reason: string;
  /** Verified after the operator signals "done". */
  checkpoint?: StateGuard;
}

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

  private channel?: OperatorChannel;

  constructor(surface: Surface, evidence: EvidenceCollector, channel?: OperatorChannel) {
    this.controlState = new ControlState();
    this.actionRecorder = new HumanActionRecorder();
    this.surface = surface;
    this.evidence = evidence;
    this.channel = channel;
  }

  /**
   * One full handoff on the live session: pause, deliver the request, let the
   * human operate while their actions are captured, then verify and hand
   * control back (signal "done") or end the run ("complete" / "abort").
   */
  async handoff(request: HandoffRequest): Promise<EscalationResult> {
    if (!this.channel) throw new Error("No operator channel configured for handoff");

    this.actionRecorder.clear();
    const escalation = await this.escalate(request.capability, request.stepId, request.reason);
    this.operatorConnected();
    await this.surface.startHumanCapture?.();

    let signal: OperatorSignal;
    try {
      signal = await this.channel.requestIntervention(escalation);
    } finally {
      const captured = (await this.surface.stopHumanCapture?.()) ?? [];
      for (const a of captured) this.actionRecorder.record(a.action, a.target, a.result);
    }
    return this.processSignal(signal, request.checkpoint);
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
    const session = await this.surface.exposeSession?.();
    if (session) {
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

    // Signal: done — verify the checkpoint, then automation takes control
    // back either way: it continues if the checkpoint holds, otherwise it
    // re-runs the step the human unblocked.
    this.controlState.transition("resuming");
    const currentState = await this.surface.observe();
    const checkpointPassed = checkpoint ? GuardChecker.check(checkpoint, currentState) : true;
    this.controlState.transition("automation");

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
    this.evidence.logStep({
      step: this.currentRequest?.stepId ?? 0,
      action: "handoff",
      target: this.currentRequest?.reason ?? "",
      result: checkpointPassed ? "success" : "failure",
      url: "",
      axSnapshot: [],
      detail: `Operator signal "${signal}"; human actions: ${
        humanActions.map((a) => `${a.action} ${a.target}`).join("; ") || "none"
      }; control history: ${this.controlState.history.map((h) => `${h.from}->${h.to}`).join(", ")}`,
    });
  }
}
