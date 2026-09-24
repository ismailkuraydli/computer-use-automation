/**
 * OpenRouterClient — real LLM client for manual discovery runs.
 * Per ADR-010: NEVER used in automated tests. Manual use only.
 *
 * Supports any OpenRouter-compatible model via cua.config.json.
 */

import type { LLMClient, LLMRequest, LLMResponse, PlanResponse, CapabilityPlan } from "./types.js";
import type { CuaConfig } from "../config.js";

export class OpenRouterClient implements LLMClient {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private maxTokens: number;
  private _callCount = 0;

  constructor(apiKey: string, config: CuaConfig) {
    this.apiKey = apiKey;
    this.model = config.model;
    this.baseUrl = config.baseUrl;
    this.maxTokens = config.maxTokens;
  }

  get callCount(): number {
    return this._callCount;
  }

  async plan(goal: string): Promise<PlanResponse> {
    this._callCount++;

    try {
      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content: `You are a computer-use agent planner. Given a natural-language goal, you analyze it and declare the capability's name, input parameters, and expected outputs.

Respond with JSON only:
{
  "capability": "<short-kebab-case-name>",
  "description": "<one sentence describing what this capability does>",
  "params": [{"name": "<paramName>", "type": "string", "required": true, "description": "<what this input is>"}],
  "outputs": [{"name": "<outputName>", "type": "string", "description": "<what this output contains>"}]
}

Rules:
- The capability name should be a short kebab-case slug (e.g. "search-wikipedia", "lookup-member-balance")
- Params are the inputs a caller would supply to replay this flow (e.g. a search query, a member ID)
- Outputs are the data extracted from the page that the caller needs back
- If the goal involves searching for something, the search term is a param
- If the goal involves reading information, the information is an output
- Keep it minimal: 1-3 params, 1-2 outputs`,
            },
            { role: "user", content: `Goal: ${goal}` },
          ],
          max_tokens: 500,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        return { ok: false, error: `Plan API error ${response.status}: ${errorBody || response.statusText}` };
      }

      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content || "";

      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        return { ok: false, error: "No JSON found in plan response" };
      }
      const parsed = JSON.parse(jsonMatch[0]) as CapabilityPlan;
      return { ok: true, plan: parsed };
    } catch (e) {
      return { ok: false, error: `Plan request failed: ${String(e)}` };
    }
  }

  async decide(request: LLMRequest): Promise<LLMResponse> {
    this._callCount++;

    try {
      const response = await fetch(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: this._buildMessages(request),
          max_tokens: this.maxTokens,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => "");
        return { ok: false, error: `API error ${response.status}: ${errorBody || response.statusText}` };
      }

      const data = await response.json() as any;
      const content = data.choices?.[0]?.message?.content || "";

      // Parse the LLM's response into an action
      return this._parseResponse(content, request);
    } catch (e) {
      return { ok: false, error: `Request failed: ${String(e)}` };
    }
  }

  private _buildMessages(request: LLMRequest): Array<{ role: string; content: string }> {
    const systemPrompt = `You are a computer-use agent. You operate a web application to achieve a goal.
You observe the current screen state and decide what action to take next.

Available actions:
- navigate: { type: "navigate", value: "<url>" }
- click: { type: "click", target: { role: "<role>", name: "<name>" } }
- type: { type: "type", target: { role: "<role>", name: "<name>" }, value: "<text>" }
- extract: { type: "extract", target: { role: "<role>", name: "<name>" }, output: "<outputName>" }
- wait: { type: "wait", value: "<ms>" }
- submit: { type: "submit", target: { role: "<role>", name: "<name>" } }

Important rules:
- Use the exact role and name from the AX tree for targets
- When you have reached the goal and extracted the needed information, use an extract action with the output name and set goalMet to true
- Always extract the information the goal asks for — do not just navigate to the page, actually read the data using extract
- If you see the data you need on the page, use extract with the appropriate output name

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
