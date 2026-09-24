/**
 * LLMClient interface — the seam between the agent loop and the LLM provider.
 * Per ADR-010: MockLLMClient for tests (zero token cost), OpenRouterClient for real runs.
 */

import type { ScreenState, Action } from "../surface/types.js";

export interface LLMRequest {
  goal: string;
  screenState: ScreenState;
  history: ActionHistoryEntry[];
  stepNumber: number;
  outputNames?: string[];  // declared output names the LLM should extract
}

export interface ActionHistoryEntry {
  step: number;
  action: Action;
  result: "success" | "failure";
  observation?: string;
}

export type LLMResponse =
  | { ok: true; action: Action; reasoning: string; goalMet: boolean }
  | { ok: false; error: string };

export interface CapabilityPlan {
  capability: string;       // slug, e.g. "search-wikipedia"
  description: string;      // human-readable, derived from the goal
  params: Array<{ name: string; type: "string" | "number" | "boolean"; required: boolean; description?: string }>;
  outputs: Array<{ name: string; type: "string" | "number" | "object"; description?: string }>;
}

export type PlanResponse =
  | { ok: true; plan: CapabilityPlan }
  | { ok: false; error: string };

export interface LLMClient {
  /** Ask the LLM to plan the capability: name, params, outputs from the goal. */
  plan(goal: string): Promise<PlanResponse>;

  /** Ask the LLM to decide the next action given the current state. */
  decide(request: LLMRequest): Promise<LLMResponse>;

  /** Number of real API calls made (0 for MockLLMClient). */
  readonly callCount: number;
}
