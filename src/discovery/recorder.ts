/**
 * Recorder — transforms agent actions into typed artifact steps.
 * Per ADR-002: Hybrid Step-List with State Guards.
 * Extracts locators from AX tree, generates guards from before-state,
 * checkpoints from after-state.
 */

import type { Action, ScreenState } from "../surface/types.js";
import type {
  CapabilityArtifact,
  ArtifactStep,
  LocatorSpec,
  StateGuard,
  ScreenSignature,
  ParamSpec,
  OutputSpec,
  SuccessCondition,
  AllowlistConfig,
  ErrorHandler,
} from "../artifact/types.js";

export class Recorder {
  private capability: string;
  private description: string;
  private allowlist: AllowlistConfig;
  private steps: ArtifactStep[] = [];
  private stepCounter = 0;
  private baseUrl: string = "";
  private knownOutputs: OutputSpec[];
  private paramValues: Record<string, string>; // paramName → concrete value used during discovery

  constructor(
    capability: string,
    description: string,
    allowlist: AllowlistConfig,
    _params: ParamSpec[] = [],
    outputs: OutputSpec[] = [],
    paramValues: Record<string, string> = {}
  ) {
    this.capability = capability;
    this.description = description;
    this.allowlist = allowlist;
    this.knownOutputs = outputs;
    this.paramValues = paramValues;
  }

  recordAction(
    action: Action,
    beforeState: ScreenState,
    afterState: ScreenState,
    _result: "success" | "failure"
  ): void {
    this.stepCounter++;

    // Extract baseUrl from first navigation
    if (this.stepCounter === 1 && action.type === "navigate" && action.value) {
      try {
        const url = new URL(action.value);
        this.baseUrl = `${url.protocol}//${url.host}`;
      } catch {
        this.baseUrl = action.value;
      }
    }

    // Build locator from the action target
    const target = this._buildLocator(action, beforeState);

    // Build guard from before-state (not for the first step)
    const guard = this.stepCounter > 1 ? this._buildGuard(beforeState) : undefined;

    // Build checkpoint from after-state
    const checkpoint = this._buildCheckpoint(afterState, action);

    const step: ArtifactStep = {
      id: this.stepCounter,
      action: action.type,
      target,
      value: action.value,
      output: action.output,
      guard,
      checkpoint,
      onError: this._generateErrorHandlers(afterState),
    };

    // If extract action has no output name, assign from known outputs
    if (action.type === "extract" && this.knownOutputs.length > 0) {
      if (!step.output) {
        step.output = this.knownOutputs[0].name;
      } else {
        // Normalize: if the LLM's output name doesn't exactly match a declared output,
        // find the closest match (case-insensitive, ignoring underscores/hyphens)
        const normalize = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
        const match = this.knownOutputs.find(o => normalize(o.name) === normalize(step.output!));
        if (match) {
          step.output = match.name;
        }
      }
    }

    // Add default "not found" handler for click steps that follow a search/type action
    // (these steps might encounter "no results" if the search returns nothing)
    if (action.type === "click" && this.stepCounter > 1) {
      if (!step.onError) step.onError = [];
      step.onError.push({
        when: {
          anyOf: [{
            textContains: "not found",
          }, {
            textContains: "No records found",
          }, {
            textContains: "No results",
          }],
        },
        handler: "fail",
        outcome: "not-found",
        description: "No results found for the search query",
      });
    }

    this.steps.push(step);
  }

  finalize(
    params: ParamSpec[],
    outputs: OutputSpec[],
    checkpoint: SuccessCondition
  ): CapabilityArtifact {
    // Canonicalize: parameterize concrete values in steps
    this._parameterizeSteps(params);

    return {
      schemaVersion: "1.0",
      artifactVersion: 1,
      capability: this.capability,
      description: this.description,
      surface: {
        type: "web",
        baseUrl: this.baseUrl,
      },
      params,
      outputs,
      allowlist: this.allowlist,
      steps: this.steps,
      checkpoint,
      metadata: {
        recordedAt: new Date().toISOString(),
        recordedBy: process.env.USER || "unknown",
      },
    };
  }

  /**
   * Parameterize steps: replace concrete param values with {{paramName}}.
   *
   * Uses the paramValues map (paramName → concrete value from discovery).
   * For each step, replaces all occurrences of the concrete value with
   * {{paramName}} in step.value and step.target.primary.name.
   *
   * This is simple string replacement — no name matching needed. If the
   * LLM typed "bananas" and paramValues is {"topic": "bananas"}, then
   * "bananas" becomes "{{topic}}" everywhere in the artifact.
   */
  private _parameterizeSteps(_params: ParamSpec[]): void {
    for (const step of this.steps) {
      // Replace concrete values in step.value (case-sensitive — search text matters)
      if (step.value && typeof step.value === "string") {
        for (const [paramName, concreteValue] of Object.entries(this.paramValues)) {
          if (concreteValue && step.value.includes(concreteValue)) {
            step.value = step.value.split(concreteValue).join(`{{${paramName}}}`);
          }
        }
      }
      // Replace concrete values in target name (case-insensitive — page titles
      // may differ in case from the search term, e.g. "Banana" vs "bananas")
      if (step.target && step.target.primary.name && typeof step.target.primary.name === "string") {
        for (const [paramName, concreteValue] of Object.entries(this.paramValues)) {
          if (concreteValue) {
            const lowerName = step.target.primary.name.toLowerCase();
            const lowerValue = concreteValue.toLowerCase();
            if (lowerName.includes(lowerValue)) {
              const regex = new RegExp(concreteValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
              step.target.primary.name = step.target.primary.name.replace(regex, `{{${paramName}}}`);
            }
          }
        }
      }
      // Replace concrete values in guard URL patterns and AX element names
      if (step.guard) {
        this._parameterizeStateGuard(step.guard);
      }
      // Replace concrete values in checkpoint URL patterns and AX element names
      if (step.checkpoint) {
        this._parameterizeStateGuard(step.checkpoint);
      }
    }
  }

  /**
   * Replace concrete param values with {{paramName}} in a StateGuard's
   * URL patterns and AX element names. Case-insensitive for URLs.
   */
  private _parameterizeStateGuard(guard: StateGuard): void {
    if (!guard.anyOf) return;
    for (const sig of guard.anyOf) {
      // Parameterize URL pattern (case-insensitive)
      if (sig.urlPattern) {
        for (const [paramName, concreteValue] of Object.entries(this.paramValues)) {
          if (concreteValue) {
            const regex = new RegExp(concreteValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            sig.urlPattern = sig.urlPattern.replace(regex, `{{${paramName}}}`);
          }
        }
      }
      // Parameterize AX element names (case-insensitive)
      if (sig.axContains) {
        for (const ax of sig.axContains) {
          if (ax.name) {
            for (const [paramName, concreteValue] of Object.entries(this.paramValues)) {
              if (concreteValue) {
                const regex = new RegExp(concreteValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                ax.name = ax.name.replace(regex, `{{${paramName}}}`);
              }
            }
          }
        }
      }
      // Parameterize textContains
      if (sig.textContains) {
        for (const [paramName, concreteValue] of Object.entries(this.paramValues)) {
          if (concreteValue) {
            const regex = new RegExp(concreteValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
            sig.textContains = sig.textContains.replace(regex, `{{${paramName}}}`);
          }
        }
      }
    }
  }

  private _buildLocator(action: Action, state: ScreenState): LocatorSpec {
    // If the action has a target (click, type, extract, submit), build from it
    if (action.target) {
      const loc: LocatorSpec = {
        primary: {
          role: action.target.role,
          name: action.target.name,
        },
      };

      // Capture exact element identity from the AX tree for replay reliability.
      // Look up the action's target in the before-state AX tree and copy all
      // identifying fields (CSS selector, id, aria-label, text, href, data-testid).
      // This is like a Playwright test selector — the replay engine uses these
      // to find the exact element without guessing.
      const axNode = state.axTree.find(
        (n) => n.role === action.target!.role && n.name === action.target!.name
      );
      if (axNode) {
        if (axNode.cssSelector) loc.primary.cssSelector = axNode.cssSelector;
        if (axNode.id) loc.primary.id = axNode.id;
        if (axNode.ariaLabel) loc.primary.ariaLabel = axNode.ariaLabel;
        if (axNode.text) loc.primary.text = axNode.text;
        if (axNode.href) loc.primary.href = axNode.href;
        if (axNode.dataTestId) loc.primary.dataTestId = axNode.dataTestId;
      }

      // Also capture DOM fallback if we have a CSS selector
      if (axNode?.cssSelector) {
        loc.fallback = {
          selector: axNode.cssSelector,
          text: axNode.text,
        };
      }

      if (action.target.framePath && action.target.framePath.length > 0) {
        loc.framePath = action.target.framePath;
      }
      return loc;
    }

    // For navigate actions, use the URL as target
    if (action.type === "navigate" && action.value) {
      return {
        primary: {
          role: "RootWebArea",
          name: action.value,
        },
      };
    }

    // Fallback
    return {
      primary: { role: "unknown", name: "unknown" },
    };
  }

  private _buildGuard(state: ScreenState): StateGuard | undefined {
    // Build a guard from the key elements in the before-state
    const keyElements = state.axTree
      .filter((n) => ["textbox", "button", "link", "heading"].includes(n.role))
      .slice(0, 3); // Top 3 key elements

    if (keyElements.length === 0) return undefined;

    const signature: ScreenSignature = {
      axContains: keyElements.map((n) => ({
        role: n.role,
        name: n.name,
      })),
      urlPattern: this._urlToPattern(state.url),
    };

    return { anyOf: [signature] };
  }

  private _buildCheckpoint(state: ScreenState, _action: Action): StateGuard | undefined {
    // Build a checkpoint from the key elements in the after-state
    // Exclude elements whose names contain param values (they're data-dependent)
    const paramConcreteValues = Object.values(this.paramValues).filter(v => v.length > 0);
    const keyElements = state.axTree
      .filter((n) => ["textbox", "button", "link", "heading", "table"].includes(n.role))
      .filter((n) => {
        // Skip elements whose name contains a param concrete value (data-dependent)
        return !paramConcreteValues.some((pv) => n.name.includes(pv));
      })
      .slice(0, 3);

    if (keyElements.length === 0) return undefined;

    const signature: ScreenSignature = {
      axContains: keyElements.map((n) => ({
        role: n.role,
        name: n.name,
      })),
      urlPattern: this._urlToPattern(state.url),
    };

    return { anyOf: [signature] };
  }

  /**
   * Generate default error handlers for a step based on the page state.
   * Detects common error patterns ("not found", "error", "invalid") in the
   * after-state and creates onError handlers that classify them as business outcomes.
   */
  private _generateErrorHandlers(state: ScreenState): ErrorHandler[] {
    const handlers: ErrorHandler[] = [];
    const allText = state.axTree.map((n) => n.name).join(" ").toLowerCase();

    // Common "not found" patterns → business outcome
    if (allText.includes("not found") || allText.includes("no records found") || allText.includes("no results")) {
      handlers.push({
        when: {
          anyOf: [{
            textContains: "not found",
          }, {
            textContains: "No records found",
          }, {
            textContains: "No results",
          }],
        },
        handler: "fail",
        outcome: "not-found",
        description: "Member or record not found",
      });
    }

    // Validation error pattern → business outcome
    if (allText.includes("validation error") || allText.includes("must be")) {
      handlers.push({
        when: {
          anyOf: [{
            textContains: "Validation Error",
          }],
        },
        handler: "fail",
        outcome: "validation-error",
        description: "Validation error on form submission",
      });
    }

    // Session timeout pattern → escalate
    if (allText.includes("session expired") || allText.includes("timed out")) {
      handlers.push({
        when: {
          anyOf: [{
            textContains: "Session Expired",
          }, {
            textContains: "timed out",
          }],
        },
        handler: "escalate",
        description: "Session expired — requires re-authentication",
      });
    }

    return handlers;
  }

  private _urlToPattern(url: string): string {
    // Normalize URL to a pattern — replace dynamic values with wildcards
    try {
      const parsed = new URL(url);
      let path = parsed.pathname;
      // Replace numeric IDs with wildcards
      path = path.replace(/\/\d+/g, "/*");
      // Replace query params with wildcards
      if (parsed.search) {
        path += "*";
      }
      return path;
    } catch {
      return url;
    }
  }
}
