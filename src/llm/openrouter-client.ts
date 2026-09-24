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
  "paramValues": {"<paramName>": "<concrete value from the goal text to use during discovery>"},
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
- paramValues: for each param, extract the concrete value mentioned in the goal text. For example, if the goal says "try bananas" and the param is "topic", then paramValues should be {"topic": "bananas"}. If the goal mentions a specific value for a param, use it. If no concrete value is mentioned, omit paramValues.
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
- scroll: { type: "scroll", value: "down" } or { type: "scroll", value: "up" } — scroll the page to see more content
- read_page_text: { type: "read_page_text" } — read all visible text on the page (use when you need to see content that is not in the AX tree)
- wait: { type: "wait", value: "<ms>" }
- submit: { type: "submit", target: { role: "<role>", name: "<name>" } }

Critical rules:
- Goals may have MULTIPLE sequential sub-goals (e.g. "do A then B then C"). You must complete EVERY sub-goal in order before setting goalMet to true.
- Before each action, review what you have already done (from the history) and what sub-goals remain. Do NOT skip any sub-goal.
- Set subGoalComplete to true when the current sub-goal is done, so the system can advance to the next sub-goal.
- Only set goalMet to true when ALL sub-goals are complete.
- After extracting output, set outputComplete to true ONLY if the extracted value fully satisfies what the goal asked for. If the output is incomplete (e.g. only got the title instead of the full article), set outputComplete to false and continue with more actions (scroll down, read_page_text, extract from another element).
- extract reads the TEXT CONTENT of the targeted element. If you extract a link, you get the link's label text (e.g. "References"), NOT the content of the page it links to.
- To extract article/research content, target a paragraph (role: "paragraph"), article (role: "article"), or the main content region (role: "main"). These contain the actual text. Do NOT target a heading (which gives just the title) or a link (which gives just the label).
- If the content is too long for a single extract, use scroll to see more content, then extract again. Or use read_page_text to get all visible text at once.
- If you need the full article text, extract from the first paragraph or the main content area — these contain the actual research text, not just the title.
- Do NOT set goalMet to true until ALL sub-goals are complete AND you have extracted meaningful data using the extract action AND outputComplete is true.
- If you need to click a link or button to reach a sub-task's target, do that FIRST, then perform the sub-task on the NEXT step.
- Use the exact role and name from the AX tree for targets.

Respond with JSON only:
{ "action": <action>, "reasoning": "<why>", "goalMet": <true|false>, "subGoalComplete": <true|false>, "outputComplete": <true|false> }`;

    const stateDesc = `Goal: ${request.goal}
Step: ${request.stepNumber}
URL: ${request.screenState.url}
Title: ${request.screenState.title}
${request.outputNames && request.outputNames.length > 0 ? `\nOutputs to extract: ${request.outputNames.join(", ")}\nYou MUST use the extract action to read these values from the page before setting goalMet to true.\n` : ""}
${request.subGoals && request.subGoals.length > 0 ? `\nSub-goals:\n${request.subGoals.map(sg => `  [${request.completedSubGoals?.includes(sg.id) ? "DONE" : request.currentSubGoal === sg.id ? "CURRENT" : "PENDING"}] ${sg.id}: ${sg.description}`).join("\n")}\n\nCurrent sub-goal: ${request.subGoals.find(sg => sg.id === request.currentSubGoal)?.description || "none"}\nFocus on completing the CURRENT sub-goal. When it is done, set subGoalComplete=true.\n` : ""}
${request.paramNames && request.paramNames.length > 0 ? `\nInput parameters available: ${request.paramNames.join(", ")}\n` : ""}
AX Tree (${request.screenState.axTree.length} total elements, showing most relevant):
${JSON.stringify(this._prioritizeAXTree(request.screenState.axTree, 100, request.subGoals?.find(sg => sg.id === request.currentSubGoal)?.keywords).map(n => ({ role: n.role, name: n.name, value: n.value })), null, 2)}

Previous actions:
${request.history.map(h => {
  const a = h.action;
  const target = a.target ? `${a.target.role}:${a.target.name}` : "";
  const val = a.value ? ` value="${a.value}"` : "";
  const out = a.output ? ` output=${a.output}` : "";
  const obs = h.observation ? ` → ${h.observation.substring(0, 100)}` : "";
  return `Step ${h.step}: ${a.type} ${target}${val}${out} -> ${h.result}${obs}`;
}).join("\n") || "None"}

REMEMBER: Review the goal, sub-goals, and the actions above. Focus on the CURRENT sub-goal. If the goal has multiple sub-goals, identify which ones are NOT yet done and do them next. Do NOT skip sub-goals. Do NOT set goalMet=true until ALL sub-goals are complete AND outputComplete=true.`;

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
        outputComplete: parsed.outputComplete === true,
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
    // Content roles — paragraphs, articles, regions contain the actual text content
    // the LLM needs for extract actions. Prioritize these over links.
    const CONTENT_ROLES = new Set(["paragraph", "article", "region", "contentinfo", "main", "document"]);

    // Normalize keywords for matching — only match whole words, not substrings
    const normKeywords = (keywords || []).map(k => k.toLowerCase()).filter(k => k.length >= 3);

    const keywordMatched: any[] = [];
    const controls: any[] = [];
    const buttons: any[] = [];
    const inputs: any[] = [];
    const labels: any[] = [];
    const headings: any[] = [];
    const content: any[] = [];
    const links: any[] = [];
    const other: any[] = [];
    const seen = new Set<string>();

    for (const node of axTree) {
      if (node.role === "StaticText" || node.role === "InlineTextBox") continue;
      if (node.role === "GenericContainer" || node.role === "Section") continue;

      const key = `${node.role}:${node.name}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // Check if this node matches any focus keywords — use exact word matching
      const nodeName = (node.name || "").toLowerCase();
      const matchesKeyword = normKeywords.length > 0 && normKeywords.some(kw =>
        nodeName === kw || nodeName.startsWith(kw + " ") || nodeName.endsWith(" " + kw) ||
        (nodeName.includes(" " + kw + " "))
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
      } else if (CONTENT_ROLES.has(node.role)) {
        content.push(node);
      } else if (node.role === "link") {
        links.push(node);
      } else {
        other.push(node);
      }
    }

    // Keyword-matched first, then controls, buttons, inputs, labels, headings,
    // content (paragraphs/articles), then links last
    const result = [...keywordMatched, ...controls, ...buttons, ...inputs, ...labels, ...headings, ...content, ...links, ...other];
    return result.slice(0, limit);
  }
}
