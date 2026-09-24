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
              content: `You are a computer-use agent planner. Given a natural-language goal, you analyze it and declare the capability's name, input parameters, expected outputs, AND decompose the goal into ordered sub-goals.

Respond with JSON only:
{
  "capability": "<short-kebab-case-name>",
  "description": "<one sentence describing what this capability does>",
  "params": [{"name": "<paramName>", "type": "string", "required": true, "description": "<what this input is>"}],
  "outputs": [{"name": "<outputName>", "type": "string", "description": "<what this output contains>"}],
  "subGoals": [
    {"id": "1", "description": "<what to do first>", "keywords": ["search", "textbox", "<element labels to find>"]},
    {"id": "2", "description": "<what to do second>", "keywords": ["<element labels relevant to this step>"]},
    {"id": "3", "description": "<what to do third>", "keywords": ["<element labels>"]}
  ]
}

Rules:
- The capability name should be a short kebab-case slug (e.g. "search-wikipedia", "lookup-member-balance")
- Params are the inputs a caller would supply to replay this flow (e.g. a search query, a member ID)
- Outputs are the data extracted from the page that the caller needs back
- If the goal involves searching for something, the search term is a param
- If the goal involves reading information, the information is an output
- Keep it minimal: 1-3 params, 1-2 outputs
- Sub-goals are ordered steps decomposed from the goal. Each sub-goal should be a single action or a small group of related actions.
- Keywords are words that appear in the AX tree elements relevant to this sub-goal (e.g. if the sub-goal is to search, keywords might be "search", "Search Wikipedia", "textbox". If the sub-goal is to change a setting, keywords might be "Appearance", "Small", "Standard", "Large", "radio")
- Keywords help the system prioritize which elements to show the LLM at each step
- Every sub-goal must be completed before the overall goal is considered met`,
            },
            { role: "user", content: `Goal: ${goal}` },
          ],
          max_tokens: 1000,
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

      // Ensure subGoals exists (fallback if LLM didn't include them)
      if (!parsed.subGoals || parsed.subGoals.length === 0) {
        parsed.subGoals = [{ id: "1", description: goal, keywords: [] }];
      }

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

      const result = this._parseResponse(content, request);
      if (!result.ok) {
        // Retry once with a simpler prompt asking for valid JSON
        console.log(`  [LLM parse error, retrying: ${result.error}]`);
        this._callCount++;
        const retryResponse = await fetch(this.baseUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify({
            model: this.model,
            messages: [
              ...this._buildMessages(request),
              { role: "assistant", content },
              { role: "user", content: "Your previous response could not be parsed as JSON. Please respond with ONLY valid JSON, no extra text, no markdown. Escape any newlines or special characters in string values using \\n, \\t, etc." },
            ],
            max_tokens: this.maxTokens,
          }),
        });

        if (retryResponse.ok) {
          const retryData = await retryResponse.json() as any;
          const retryContent = retryData.choices?.[0]?.message?.content || "";
          return this._parseResponse(retryContent, request);
        }
      }
      return result;
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
- Goals may have MULTIPLE sequential sub-goals (e.g. "do A then B then C"). You must complete EVERY sub-goal in order before setting goalMet to true.
- Before each action, review what you have already done (from the history) and what sub-goals remain. Do NOT skip any sub-goal.
- Set subGoalComplete to true when the current sub-goal is done, so the system can advance to the next sub-goal.
- Only set goalMet to true when ALL sub-goals are complete.
- extract reads the TEXT CONTENT of the targeted element. If you extract a link, you get the link's label text (e.g. "References"), NOT the content of the page it links to.
- To extract paragraph content, target the paragraph element (role: "paragraph") or a heading whose text IS the content you want.
- To get article/research text, navigate to the page with the content, then extract from the element that CONTAINS the text (e.g. a paragraph, article, or region element — NOT a link to that content).
- Do NOT set goalMet to true until ALL sub-goals are complete AND you have extracted meaningful data using the extract action.
- If you need to click a link or button to reach a sub-task's target, do that FIRST, then perform the sub-task on the NEXT step.
- Use the exact role and name from the AX tree for targets.

Respond with JSON only:
{ "action": <action>, "reasoning": "<why>", "goalMet": <true|false>, "subGoalComplete": <true|false> }`;

    const stateDesc = `Goal: ${request.goal}
Step: ${request.stepNumber}
URL: ${request.screenState.url}
Title: ${request.screenState.title}
${request.outputNames && request.outputNames.length > 0 ? `\nOutputs to extract: ${request.outputNames.join(", ")}\nYou MUST use the extract action to read these values from the page before setting goalMet to true.\n` : ""}
${request.subGoals && request.subGoals.length > 0 ? `\nSub-goals:\n${request.subGoals.map(sg => `  [${request.completedSubGoals?.includes(sg.id) ? "DONE" : request.currentSubGoal === sg.id ? "CURRENT" : "PENDING"}] ${sg.id}: ${sg.description}`).join("\n")}\n\nCurrent sub-goal: ${request.subGoals.find(sg => sg.id === request.currentSubGoal)?.description || "none"}\nFocus on completing the CURRENT sub-goal. When it is done, set subGoalComplete=true.\n` : ""}
AX Tree (${request.screenState.axTree.length} total elements, showing most relevant):
${JSON.stringify(this._prioritizeAXTree(request.screenState.axTree, 100, request.subGoals?.find(sg => sg.id === request.currentSubGoal)?.keywords), null, 2)}

Previous actions:
${request.history.map(h => {
  const a = h.action;
  const target = a.target ? `${a.target.role}:${a.target.name}` : "";
  const val = a.value ? ` value="${a.value}"` : "";
  const out = a.output ? ` output=${a.output}` : "";
  return `Step ${h.step}: ${a.type} ${target}${val}${out} -> ${h.result}`;
}).join("\n") || "None"}

REMEMBER: Review the goal, sub-goals, and the actions above. Focus on the CURRENT sub-goal. If the goal has multiple sub-goals, identify which ones are NOT yet done and do them next. Do NOT skip sub-goals. Do NOT set goalMet=true until ALL sub-goals are complete.`;

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

      // Sanitize control characters that break JSON.parse
      // LLMs sometimes include raw newlines/tabs inside string values
      let jsonStr = jsonMatch[0];
      // Replace raw control characters inside string literals
      jsonStr = jsonStr.replace(/[\x00-\x1f]/g, (match) => {
        if (match === "\n" || match === "\r" || match === "\t") {
          return " ";
        }
        return "";
      });

      const parsed = JSON.parse(jsonStr);
      return {
        ok: true,
        action: parsed.action,
        reasoning: parsed.reasoning || "",
        goalMet: parsed.goalMet || false,
        subGoalComplete: parsed.subGoalComplete === true,
      };
    } catch (e) {
      return { ok: false, error: `Failed to parse LLM response: ${String(e)}` };
    }
  }

  /**
   * Prioritize interactive elements in the AX tree so the LLM sees the most
   * actionable controls first. On large pages (e.g. Wikipedia with 11000+ AX
   * elements and 2000+ interactive links), the settings radio buttons would
   * be buried among hundreds of article citation links.
   *
   * Priority order within interactive elements:
   * 1. Controls: radio, checkbox, switch, slider, combobox, tab, menuitem,
   *    option, spinbutton (user-facing settings/toggles)
   * 2. Buttons: button, submit (actionable buttons)
   * 3. Text inputs: textbox, searchbox (form fields)
   * 4. Labels: label (associated with settings/controls)
   * 5. Links: link (navigation — deprioritize, there are usually hundreds)
   *
   * Also deduplicates by role+name (keep first occurrence only).
   * Filters out StaticText, InlineTextBox, GenericContainer, Section.
   */
  private _prioritizeAXTree(axTree: any[], limit: number = 100, keywords?: string[]): any[] {
    const CONTROL_ROLES = new Set([
      "radio", "checkbox", "switch", "slider", "combobox", "tab",
      "menuitem", "menuitemcheckbox", "menuitemradio", "option", "spinbutton",
    ]);
    const BUTTON_ROLES = new Set(["button", "submit"]);
    const INPUT_ROLES = new Set(["textbox", "searchbox", "listbox"]);
    const LABEL_ROLES = new Set(["label"]);
    const HEADING_ROLES = new Set(["heading"]);

    // Normalize keywords for matching
    const normKeywords = (keywords || []).map(k => k.toLowerCase());

    const keywordMatched: any[] = [];
    const controls: any[] = [];
    const buttons: any[] = [];
    const inputs: any[] = [];
    const labels: any[] = [];
    const headings: any[] = [];
    const links: any[] = [];
    const other: any[] = [];
    const seen = new Set<string>();

    for (const node of axTree) {
      if (node.role === "StaticText" || node.role === "InlineTextBox") continue;
      if (node.role === "GenericContainer" || node.role === "Section") continue;

      const key = `${node.role}:${node.name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Check if this node matches any focus keywords
      const nodeName = (node.name || "").toLowerCase();
      const matchesKeyword = normKeywords.length > 0 && normKeywords.some(kw =>
        nodeName.includes(kw) || kw.includes(nodeName)
      );

      if (matchesKeyword) {
        keywordMatched.push(node);
      } else if (CONTROL_ROLES.has(node.role)) {
        controls.push(node);
      } else if (BUTTON_ROLES.has(node.role)) {
        buttons.push(node);
      } else if (INPUT_ROLES.has(node.role)) {
        inputs.push(node);
      } else if (LABEL_ROLES.has(node.role)) {
        labels.push(node);
      } else if (HEADING_ROLES.has(node.role)) {
        headings.push(node);
      } else if (node.role === "link") {
        links.push(node);
      } else {
        other.push(node);
      }
    }

    // Keyword-matched elements first, then the rest by priority
    const result = [...keywordMatched, ...controls, ...buttons, ...inputs, ...labels, ...headings, ...links, ...other];
    return result.slice(0, limit);
  }
}
