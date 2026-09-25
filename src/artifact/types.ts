/**
 * Artifact types — the central contract of the system.
 *
 * Schema v2. Site knowledge lives in data, never in engine code:
 * - an artifact describes ONE capability: typed params/outputs, ordered steps,
 *   a semantic target per step and an enforced checkpoint after each step;
 * - an app profile (profile-types.ts) describes the runtime conditions every
 *   screen of an app can show, shared by all artifacts for that app.
 *
 * Every text field in a target, value or checkpoint may contain {{param}}
 * templates; they are substituted before matching. Text matching is
 * whole-text and case-insensitive.
 */

export const ARTIFACT_SCHEMA_VERSION = "2.0";

export type ActionType =
  | "navigate"
  | "click"
  | "type"
  | "select"
  | "extract"
  | "wait"
  | "submit"
  | "scroll"
  | "read_page_text";

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

/**
 * How a step identifies the element it acts on — by what an operator sees,
 * never by DOM position. Works the same over a browser accessibility tree,
 * UIA on Windows or AX on macOS.
 *
 * - role + name: the element with this role and accessible name.
 * - row: restrict to the table row that has a cell with exactly this text
 *   (e.g. the "Manage" link in the row whose type is {{accountType}}).
 * - column (extract, with row): the cell under this column header.
 * - label (extract): the cell next to the cell with this label, for
 *   key/value tables ("Current Balance" → "$12,847.00").
 * - frame: names of the frames to descend into, outermost first.
 */
export interface TargetSpec {
  role: string;
  name?: string;
  row?: string;
  column?: string;
  label?: string;
  frame?: string[];
}

export interface ElementRef {
  role: string;
  name: string;
}

/** A recognizable screen: every present field must match. */
export interface ScreenSignature {
  axContains?: ElementRef[];
  urlPattern?: string;
  textContains?: string;
}

export interface StateGuard {
  anyOf?: ScreenSignature[];
  allOf?: ScreenSignature[];
}

/**
 * What a recognized runtime condition means for the caller.
 * - business-outcome: a legitimate answer ("no such member"); stop, report it.
 * - retry: transient; re-run the current step (never an irreversible one).
 * - escalate: a human must act on the live session.
 * - hard-failure: known to be unrecoverable; stop with a clear error.
 */
export type ConditionKind = "business-outcome" | "retry" | "escalate" | "hard-failure";

export interface ErrorHandler {
  when: StateGuard;
  kind: ConditionKind;
  /** Machine-readable outcome for business outcomes, e.g. "not-found". */
  outcome?: string;
  maxRetries?: number;
  description: string;
}

export interface ArtifactStep {
  id: number;
  action: ActionType;
  /** Absent for navigate, wait, scroll and read_page_text. */
  target?: TargetSpec;
  value?: string;
  output?: string;
  /** Must hold after the step; replay waits for it, then enforces it. */
  checkpoint?: StateGuard;
  /** Step-specific conditions, checked before the app profile's. */
  onError?: ErrorHandler[];
  classification?: "safe" | "risky" | "irreversible";
}

export interface SuccessCondition extends ScreenSignature {
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
    /** App profile name — shared runtime conditions for this app. */
    app?: string;
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
    migratedFrom?: string;
    /** Result of replaying the artifact right after discovery. */
    selfCheck?: string;
  };
}
