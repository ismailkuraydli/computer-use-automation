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

Critical rules:
- Goals may have MULTIPLE sequential sub-tasks (e.g. "do A then B then C"). You must complete EVERY sub-task in order before setting goalMet to true.
- Before each action, review what you have already done (from the history) and what sub-tasks remain. Do NOT skip any sub-task.
- extract reads the TEXT CONTENT of the targeted element. If you extract a link, you get the link's label text (e.g. "References"), NOT the content of the page it links to.
- To extract paragraph content, target the paragraph element (role: "paragraph") or a heading whose text IS the content you want.
- To get article/research text, navigate to the page with the content, then extract from the element that CONTAINS the text (e.g. a paragraph, article, or region element — NOT a link to that content).
- Do NOT set goalMet to true until ALL sub-tasks are complete AND you have extracted meaningful data using the extract action.
- If you need to click a link or button to reach a sub-task's target, do that FIRST, then perform the sub-task on the NEXT step.
- Use the exact role and name from the AX tree for targets.

Respond with JSON only:
{ "action": <action>, "reasoning": "<why>", "goalMet": <true|false> }`;

    const stateDesc = `Goal: ${request.goal}
Step: ${request.stepNumber}
URL: ${request.screenState.url}
Title: ${request.screenState.title}
${request.outputNames && request.outputNames.length > 0 ? `\nOutputs to extract: ${request.outputNames.join(", ")}\nYou MUST use the extract action to read these values from the page before setting goalMet to true.\n` : ""}
AX Tree (${request.screenState.axTree.length} total elements, showing most relevant):
${JSON.stringify(this._prioritizeAXTree(request.screenState.axTree, 100), null, 2)}

Previous actions:
${request.history.map(h => {
  const a = h.action;
  const target = a.target ? `${a.target.role}:${a.target.name}` : "";
  const val = a.value ? ` value="${a.value}"` : "";
  const out = a.output ? ` output=${a.output}` : "";
  return `Step ${h.step}: ${a.type} ${target}${val}${out} -> ${h.result}`;
}).join("\n") || "None"}

REMEMBER: Review the goal and the actions above. If the goal has multiple sub-tasks, identify which ones are NOT yet done and do them next. Do NOT skip sub-tasks. Do NOT set goalMet=true until everything is complete.`;

    return [
      { role: "system", content: systemPrompt },
      { role: "user", content: stateDesc },
    ];
  }

  private _parseResponse(content: string, _request: LLMRequest): LLMResponse {
    try {
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

  /**
   * Prioritize interactive elements in the AX tree so the LLM sees buttons,
   * links, radio buttons, checkboxes, textboxes, labels, and comboboxes first.
   * On large pages (e.g. Wikipedia with 11000+ elements), the first 80 elements
   * are all navigation links — the actual interactive controls (settings, forms)
   * are buried deep and never reach the LLM's view.
   *
   * Strategy: sort by priority (interactive > headings > text), take top N.
   */
  private _prioritizeAXTree(axTree: any[], limit: number = 100): any[] {
    const INTERACTIVE_ROLES = new Set([
      "button", "link", "textbox", "radio", "checkbox", "combobox",
      "menuitem", "menuitemcheckbox", "menuitemradio", "tab",
      "switch", "slider", "searchbox", "spinbutton", "listbox",
      "option", "label",
    ]);

    const HEADING_ROLES = new Set(["heading"]);

    // Split into priority groups
    const interactive: any[] = [];
    const headings: any[] = [];
    const other: any[] = [];

    for (const node of axTree) {
      // Skip StaticText and InlineTextBox (article content, not interactive)
      if (node.role === "StaticText" || node.role === "InlineTextBox") continue;
      // Skip generic containers
      if (node.role === "GenericContainer" || node.role === "Section") continue;

      if (INTERACTIVE_ROLES.has(node.role)) {
        interactive.push(node);
      } else if (HEADING_ROLES.has(node.role)) {
        headings.push(node);
      } else {
        other.push(node);
      }
    }

    // Combine: interactive first, then headings, then other — up to limit
    const result = [...interactive, ...headings, ...other];
    return result.slice(0, limit);
  }
}
