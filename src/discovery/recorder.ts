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
} from "../artifact/types.js";

export class Recorder {
  private capability: string;
  private description: string;
  private allowlist: AllowlistConfig;
  private steps: ArtifactStep[] = [];
  private stepCounter = 0;
  private baseUrl: string = "";

  constructor(capability: string, description: string, allowlist: AllowlistConfig) {
    this.capability = capability;
    this.description = description;
    this.allowlist = allowlist;
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
    };

    this.steps.push(step);
  }

  finalize(
    params: ParamSpec[],
    outputs: OutputSpec[],
    checkpoint: SuccessCondition
  ): CapabilityArtifact {
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
    const keyElements = state.axTree
      .filter((n) => ["textbox", "button", "link", "heading", "table"].includes(n.role))
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
