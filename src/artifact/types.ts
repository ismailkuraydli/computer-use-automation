/**
 * Artifact types — the central contract of the system.
 * Per ADR-002: Hybrid Step-List with State Guards.
 * Per the assignment: typed, versioned, serializable, reviewable.
 */

import type { AXLocator } from "../locator/types.js";

export type ActionType = "navigate" | "click" | "type" | "extract" | "wait" | "submit";

export interface ParamSpec {
  name: string;
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
  redact?: boolean;
}

export interface OutputSpec {
  name: string;
  type: "string" | "number" | "object";
  description?: string;
}

export interface AllowlistConfig {
  permittedDomains: string[];
  permittedUrlPatterns: string[];
  permittedActions: ActionType[];
  riskyActions?: ActionType[];
  irreversibleActions?: ActionType[];
}

export interface DOMLocator {
  selector: string;
  text?: string;
  position?: { index: number };
}

export interface VisualLocator {
  region: { x: number; y: number; w: number; h: number };
  description: string;
}

export interface LocatorSpec {
  primary: AXLocator;
  fallback?: DOMLocator;
  visual?: VisualLocator;
  framePath?: string[];
}

export interface ScreenSignature {
  axContains?: AXLocator[];
  urlPattern?: string;
  textContains?: string;
}

export interface StateGuard {
  anyOf?: ScreenSignature[];
  allOf?: ScreenSignature[];
  expect?: "loaded" | "unloaded";
}

export interface ErrorHandler {
  when: StateGuard;
  handler: "retry" | "dismiss" | "wait" | "fail" | "escalate";
  maxRetries?: number;
  outcome?: string;
  description?: string;
}

export interface ArtifactStep {
  id: number;
  action: ActionType;
  target: LocatorSpec;
  value?: string;
  output?: string;
  guard?: StateGuard;
  checkpoint?: StateGuard;
  onError?: ErrorHandler[];
  classification?: "safe" | "risky" | "irreversible";
}

export interface SuccessCondition {
  axContains?: AXLocator[];
  urlPattern?: string;
  outputsExtracted?: boolean;
}

export interface CapabilityArtifact {
  schemaVersion: string;
  artifactVersion: number;
  capability: string;
  description: string;
  surface: {
    type: "web" | "desktop";
    baseUrl: string;
    appVersion?: string;
  };
  params: ParamSpec[];
  outputs: OutputSpec[];
  allowlist: AllowlistConfig;
  steps: ArtifactStep[];
  checkpoint: SuccessCondition;
  metadata: {
    recordedAt: string;
    recordedBy: string;
    tenantOverrides?: string;
  };
}
