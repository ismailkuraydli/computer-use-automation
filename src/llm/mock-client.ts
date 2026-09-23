/**
 * MockLLMClient — scripted LLM responses for tests.
 * Per ADR-010: zero token cost, deterministic, no real API calls.
 */

import type { LLMClient, LLMRequest, LLMResponse } from "./types.js";
import type { Action } from "../surface/types.js";

export interface ScriptedStep {
  action: Action;
  reasoning: string;
  goalMet: boolean;
}

export class MockLLMClient implements LLMClient {
  private script: ScriptedStep[];
  private stepIndex = 0;
  private _callCount = 0;

  constructor(script: ScriptedStep[]) {
    this.script = script;
  }

  get callCount(): number {
    return this._callCount;
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
