/**
 * MockLLMClient — scripted LLM responses for tests.
 * Per ADR-010: zero token cost, deterministic, no real API calls.
 */

import type { LLMClient, LLMRequest, LLMResponse, PlanResponse, CapabilityPlan } from "./types.js";
import type { Action } from "../surface/types.js";

export interface ScriptedStep {
  action: Action;
  reasoning: string;
  goalMet: boolean;
}

export interface MockLLMOptions {
  script: ScriptedStep[];
  plan?: CapabilityPlan;
}

export class MockLLMClient implements LLMClient {
  private script: ScriptedStep[];
  private mockPlan: CapabilityPlan | null;
  private stepIndex = 0;
  private _callCount = 0;

  constructor(opts: ScriptedStep[] | MockLLMOptions) {
    if (Array.isArray(opts)) {
      this.script = opts;
      this.mockPlan = null;
    } else {
      this.script = opts.script;
      this.mockPlan = opts.plan || null;
    }
  }

  get callCount(): number {
    return this._callCount;
  }

  async plan(goal: string): Promise<PlanResponse> {
    if (this.mockPlan) {
      return { ok: true, plan: this.mockPlan };
    }
    // Auto-generate a basic plan from the goal
    const slug = goal.toLowerCase()
      .replace(/[^a-z0-9\s]/g, "")
      .trim()
      .split(/\s+/)
      .slice(0, 4)
      .join("-");
    return {
      ok: true,
      plan: {
        capability: slug,
        description: goal,
        params: [{ name: "searchQuery", type: "string", required: true, description: "The search query" }],
        outputs: [{ name: "result", type: "string", description: "The extracted result" }],
      },
    };
  }

  async decide(_request: LLMRequest): Promise<LLMResponse> {
    this._callCount++;

    // callCount tracks mock calls, not real API calls — it's always 0 for real
    // The test verifies callCount === script.length (all mock calls used) and
    // that no real client was ever instantiated.

    if (this.stepIndex >= this.script.length) {
      return {
        ok: false,
        error: "Script exhausted — no more scripted actions",
      };
    }

    const step = this.script[this.stepIndex];
    this.stepIndex++;

    return {
      ok: true,
      action: step.action,
      reasoning: step.reasoning,
      goalMet: step.goalMet,
    };
  }
}
