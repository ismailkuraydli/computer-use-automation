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
  outputNames?: string[];
  paramNames?: string[];      // available input parameter names
  subGoals?: SubGoal[];
  completedSubGoals?: string[];
  currentSubGoal?: string;
}

export interface SubGoal {
  id: string;           // e.g. "1", "2", "3"
  description: string;  // e.g. "Navigate to the flowers page"
  keywords?: string[];  // keywords to prioritize in AX tree, e.g. ["search", "flower", "Search Wikipedia"]
}

export interface ActionHistoryEntry {
  step: number;
  action: Action;
  result: "success" | "failure";
  observation?: string;
}

export type LLMResponse =
  | { ok: true; action: Action; reasoning: string; goalMet: boolean; subGoalComplete?: boolean; outputComplete?: boolean }
  | { ok: false; error: string };

export interface CapabilityPlan {
  capability: string;
  description: string;
  params: Array<{ name: string; type: "string" | "number" | "boolean"; required: boolean; description?: string }>;
  outputs: Array<{ name: string; type: "string" | "number" | "object"; description?: string }>;
  subGoals: SubGoal[];   // ordered sub-goals decomposed from the goal
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
