/**
 * OperatorChannel — how an intervention request reaches a human and how the
 * human signals that control can come back.
 *
 * The terminal channel is the deliberately minimal operator UI: it prints
 * the request (capability, step, reason, screenshot, how to reach the live
 * session) and waits for a typed signal. A real deployment would put a queue
 * and a web console behind the same interface.
 */

import { createInterface } from "readline";
import type { EscalationRequest } from "./escalation-request.js";
import type { OperatorSignal } from "./escalation-manager.js";

export interface OperatorChannel {
  /** Deliver the request; resolve with the operator's signal once they are done. */
  requestIntervention(request: EscalationRequest): Promise<OperatorSignal>;
}

const SIGNALS: readonly OperatorSignal[] = ["done", "complete", "abort"];

export class TerminalOperatorChannel implements OperatorChannel {
  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stdout
  ) {}

  async requestIntervention(request: EscalationRequest): Promise<OperatorSignal> {
    this.output.write(formatRequest(request));
    const rl = createInterface({ input: this.input, output: this.output, terminal: false });
    try {
      for await (const line of rl) {
        const signal = line.trim().toLowerCase() as OperatorSignal;
        if (SIGNALS.includes(signal)) return signal;
        this.output.write(`Type one of: ${SIGNALS.join(", ")}\n`);
      }
      return "abort"; // input closed without a signal
    } finally {
      rl.close();
    }
  }
}

function formatRequest(request: EscalationRequest): string {
  return [
    "",
    "=== HUMAN INTERVENTION REQUESTED ===",
    `Capability: ${request.capability}`,
    `Step:       ${request.stepId}`,
    `Reason:     ${request.reason}`,
    `Page:       ${request.screenState.url}`,
    request.screenState.screenshotPath ? `Screenshot: ${request.screenState.screenshotPath}` : "",
    request.cdpEndpoint ? `Live session (CDP): ${request.cdpEndpoint}` : "Live session: the open browser window",
    "",
    "Automation is paused. Operate the live session, then type:",
    "  done      — I fixed it; verify this step and resume automation",
    "  complete  — I finished the task myself; end the run",
    "  abort     — stop the run",
    "> ",
  ]
    .filter((line) => line !== "")
    .join("\n");
}
