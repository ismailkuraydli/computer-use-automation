/**
 * EscalationRequest — the context carried when escalating to a human operator.
 */

import type { ScreenState, ActionType } from "../surface/types.js";

export interface EscalationRequest {
  capability: string;
  stepId: number;
  screenState: ScreenState;
  reason: string;
  timestamp: string;
  cdpEndpoint?: string;
  token?: string;
}

export interface HumanAction {
  action: ActionType;
  target: string;
  timestamp: string;
  result: "success" | "failure";
}

export function createEscalationRequest(
  capability: string,
  stepId: number,
  screenState: ScreenState,
  reason: string
): EscalationRequest {
  return {
    capability,
    stepId,
    screenState,
    reason,
    timestamp: new Date().toISOString(),
  };
}
