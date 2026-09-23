/**
 * ControlState — state machine for who controls the live session.
 * Per ADR-006: automation → paused → human → resuming → automation
 *
 * States:
 * - automation: the agent loop / replay engine is in control
 * - paused: automation has stopped, waiting for human to connect
 * - human: the human operator is in control of the live session
 * - resuming: human has signaled done, verifying state before resuming
 * - done: the escalation is complete (terminal state)
 */

export type ControlStateValue = "automation" | "paused" | "human" | "resuming" | "done";

const VALID_TRANSITIONS: Record<ControlStateValue, ControlStateValue[]> = {
  automation: ["paused"],
  paused: ["human", "done"],
  human: ["resuming", "done"],
  resuming: ["automation", "done"],
  done: [],
};

export class ControlState {
  private state: ControlStateValue = "automation";
  private transitions: Array<{ from: ControlStateValue; to: ControlStateValue; at: string }> = [];

  get current(): ControlStateValue {
    return this.state;
  }

  get history(): Array<{ from: ControlStateValue; to: ControlStateValue; at: string }> {
    return [...this.transitions];
  }

  transition(to: ControlStateValue): boolean {
    const allowed = VALID_TRANSITIONS[this.state];
    if (!allowed.includes(to)) {
      return false;
    }
    this.transitions.push({ from: this.state, to, at: new Date().toISOString() });
    this.state = to;
    return true;
  }

  canTransitionTo(to: ControlStateValue): boolean {
    return VALID_TRANSITIONS[this.state].includes(to);
  }
}
