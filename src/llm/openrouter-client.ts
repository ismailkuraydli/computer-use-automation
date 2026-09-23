/**
 * OpenRouterClient — real Claude via OpenRouter for manual discovery runs.
 * Per ADR-010: NEVER used in automated tests. Manual use only.
 */

import type { LLMClient, LLMRequest, LLMResponse } from "./types.js";

export class OpenRouterClient implements LLMClient {
  private apiKey: string;
  private model: string;
  private _callCount = 0;

  constructor(apiKey: string, model = "anthropic/claude-3.5-sonnet") {
    this.apiKey = apiKey;
    this.model = model;
  }

  get callCount(): number {
    return this._callCount;
  }

  async decide(request: LLMRequest): Promise<LLMResponse> {
    this._callCount++;

    try {
      const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: this._buildMessages(request),
          max_tokens: 1000,
        }),
      });

      if (!response.ok) {
        return { ok: false, error: `OpenRouter API error: ${response.status} ${response.statusText}` };
      }

      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content || "";

      // Parse the LLM's response into an action
      return this._parseResponse(content, request);
    } catch (e) {
      return { ok: false, error: `OpenRouter request failed: ${String(e)}` };
    }
  }

  private _buildMessages(request: LLMRequest): Array<{ role: string; content: string }> {
    const systemPrompt = `You are a computer-use agent. You operate a web application to achieve a goal.
You observe the current screen state and decide what action to take next.

Available actions:
- navigate: { type: "navigate", value: "<url>" }
- click: { type: "click", target: { role: "<role>", name: "<name>" } }
- type: { type: "type", target: { role: "<role>", name: "<name>" }, value: "<text>" }
- extract: { type: "extract", target: { role: "<role>", name: "<name>" } }
- wait: { type: "wait", value: "<ms>" }
- submit: { type: "submit", target: { role: "<role>", name: "<name>" } }

Respond with JSON only:
{ "action": <action>, "reasoning": "<why>", "goalMet": <true|false> }`;

    const stateDesc = `Goal: ${request.goal}
Step: ${request.stepNumber}
URL: ${request.screenState.url}
Title: ${request.screenState.title}

AX Tree (accessible elements):
${JSON.stringify(request.screenState.axTree, null, 2)}

Previous actions:
${request.history.map(h => `Step ${h.step}: ${h.action.type} -> ${h.result}`).join("\n") || "None"}`;

    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: stateDesc },
    ];
  }

  private _parseResponse(content: string, _request: LLMRequest): LLMResponse {
    try {
      // Extract JSON from the response
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { ok: false, error: "No JSON found in LLM response" };
      }
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        ok: true,
        action: parsed.action,
        reasoning: parsed.reasoning || "",
        goalMet: parsed.goalMet || false,
      };
    } catch (e) {
      return { ok: false, error: `Failed to parse LLM response: ${String(e)}` };
    }
  }
}
