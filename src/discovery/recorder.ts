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
  private paramValueMap: Map<string, string> = new Map(); // concreteValue → paramName
  private knownParams: ParamSpec[];

  constructor(capability: string, description: string, allowlist: AllowlistConfig, params: ParamSpec[] = []) {
    this.capability = capability;
    this.description = description;
    this.allowlist = allowlist;
    this.knownParams = params;
  }

  recordAction(
    action: Action,
    beforeState: ScreenState,
    afterState: ScreenState,
    _result: "success" | "failure"
  ): void {
    this.stepCounter++;

    // Track param value mappings for canonicalization
    if (action.type === "type" && action.value && action.target) {
      const targetName = action.target.name.toLowerCase().replace(/\s+/g, "");
      for (const param of this.knownParams) {
        const paramName = param.name.toLowerCase().replace(/\s+/g, "");
        if (targetName.includes(paramName) || paramName.includes(targetName)) {
          this.paramValueMap.set(action.value, param.name);
          break;
        }
      }
    }

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

    // Add default "not found" handler for navigate steps to detail pages
    if (action.type === "navigate" && action.value && action.value.includes("detail")) {
      if (!step.onError) step.onError = [];
      step.onError.push({
        when: {
          anyOf: [{
            textContains: "not found",
          }, {
            textContains: "Member not found",
          }],
        },
        handler: "fail",
        outcome: "member-not-found",
        description: "Member not found — legitimate business outcome",
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
   * Canonicalize steps: replace concrete param values with {{paramName}} references.
   * This is the core of the cross-tenant reuse design (ADR-009).
   *
   * Strategy: for each `type` action, if the target's name matches a param name
   * (case-insensitive, ignoring spaces), record the mapping from concrete value → paramName.
   * Then replace all occurrences of concrete values in step values (including navigate URLs).
   */
  private _parameterizeSteps(_params: ParamSpec[]): void {
    // paramValueMap is already populated during recordAction() calls
    // Replace concrete values with {{paramName}} in all steps
    for (const step of this.steps) {
      if (step.value) {
        for (const [concreteValue, paramName] of this.paramValueMap) {
          step.value = step.value.split(concreteValue).join(`{{${paramName}}}`);
        }
      }
      // Also parameterize the target name for navigate steps (RootWebArea name = URL)
      if (step.target && step.target.primary.name) {
        for (const [concreteValue, paramName] of this.paramValueMap) {
          step.target.primary.name = step.target.primary.name.split(concreteValue).join(`{{${paramName}}}`);
        }
      }
    }
  }

  private _buildLocator(action: Action, _state: ScreenState): LocatorSpec {
    // If the action has a target (click, type, extract, submit), build from it
    if (action.target) {
      const loc: LocatorSpec = {
        primary: {
          role: action.target.role,
          name: action.target.name,
        },
      };
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
    const paramValues = Array.from(this.paramValueMap.keys());
    const keyElements = state.axTree
      .filter((n) => ["textbox", "button", "link", "heading", "table"].includes(n.role))
      .filter((n) => {
        // Skip elements whose name contains a param concrete value (data-dependent)
        return !paramValues.some((pv) => n.name.includes(pv));
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
