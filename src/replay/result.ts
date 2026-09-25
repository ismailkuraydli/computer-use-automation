/**
 * ReplayResult — the typed contract returned by the ReplayEngine.
 *
 * - success: the capability ran; outputs are returned. If a human stepped in
 *   along the way, their actions are listed so the caller knows.
 * - business-outcome: a legitimate answer ("not-found"), not an error.
 * - failure: a hard failure with what was expected vs observed at which step.
 * - escalated: a human is needed (or was, and ended the run): `resolution`
 *   says whether nobody took over, the human finished the task, or aborted.
 */

import type { HumanAction } from "../surface/types.js";

export type EscalationResolution = "unresolved" | "completed-by-human" | "aborted";

export type ReplayResult =
  | { status: "success"; outputs: Record<string, string | number | object>; humanActions?: HumanAction[]; evidencePath: string }
  | { status: "business-outcome"; outcome: string; detail: string; evidencePath: string }
  | { status: "failure"; stepId: number; expected: string; observed: string; error: string; evidencePath: string }
  | {
      status: "escalated";
      stepId: number;
      reason: string;
      resolution: EscalationResolution;
      humanActions?: HumanAction[];
      evidencePath: string;
    };

export function success(
  outputs: Record<string, string | number | object>,
  evidencePath: string,
  humanActions: HumanAction[] = []
): ReplayResult {
  return humanActions.length > 0
    ? { status: "success", outputs, humanActions, evidencePath }
    : { status: "success", outputs, evidencePath };
}

export function businessOutcome(outcome: string, detail: string, evidencePath: string): ReplayResult {
  return { status: "business-outcome", outcome, detail, evidencePath };
}

export function failure(stepId: number, expected: string, observed: string, error: string, evidencePath: string): ReplayResult {
  return { status: "failure", stepId, expected, observed, error, evidencePath };
}

export function escalated(
  stepId: number,
  reason: string,
  evidencePath: string,
  humanActions?: HumanAction[],
  resolution: EscalationResolution = "unresolved"
): ReplayResult {
  return { status: "escalated", stepId, reason, resolution, ...(humanActions?.length ? { humanActions } : {}), evidencePath };
}
