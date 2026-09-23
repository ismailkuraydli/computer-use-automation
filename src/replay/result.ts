/**
 * ReplayResult — the typed contract returned by the ReplayEngine.
 * Per ADR-004: three-tier error taxonomy (business outcome / recoverable / hard failure).
 */

import type { ActionType } from "../artifact/types.js";

export interface HumanAction {
  action: ActionType;
  target: string;
  timestamp: string;
  result: "success" | "failure";
}

export type ReplayResult =
  | { status: "success"; outputs: Record<string, string | number | object>; evidencePath: string }
  | { status: "business-outcome"; outcome: string; detail: string; evidencePath: string }
  | { status: "failure"; stepId: number; expected: string; observed: string; error: string; evidencePath: string }
  | { status: "escalated"; stepId: number; reason: string; humanActions?: HumanAction[]; evidencePath: string };

export function success(outputs: Record<string, string | number | object>, evidencePath: string): ReplayResult {
  return { status: "success", outputs, evidencePath };
}

export function businessOutcome(outcome: string, detail: string, evidencePath: string): ReplayResult {
  return { status: "business-outcome", outcome, detail, evidencePath };
}

export function failure(stepId: number, expected: string, observed: string, error: string, evidencePath: string): ReplayResult {
  return { status: "failure", stepId, expected, observed, error, evidencePath };
}

export function escalated(stepId: number, reason: string, evidencePath: string, humanActions?: HumanAction[]): ReplayResult {
  return { status: "escalated", stepId, reason, humanActions, evidencePath };
}
