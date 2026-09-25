/**
 * EscalationRequest — the context carried when escalating to a human operator.
 */

import type { ScreenState, HumanAction } from "../surface/types.js";

export type { HumanAction };

export interface EscalationRequest {
  capability: string;
  stepId: number;
  screenState: ScreenState;
  reason: string;
  timestamp: string;
  cdpEndpoint?: string;
  token?: string;
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
