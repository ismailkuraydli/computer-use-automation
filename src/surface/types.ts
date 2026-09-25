/**
 * Surface types — the interface between the automation system and the
 * target application. Surface-agnostic: never leaks Playwright types.
 * Per ADR-008: this interface is the seam that enables extending to
 * desktop surfaces without changing the artifact schema or replay engine.
 */

// --- AX Tree types ---

/** Where a node sits in a table, as an operator would describe it. */
export interface NodeContext {
  row?: string[];      // texts of the cells in the node's table row
  column?: string;     // header text of the node's column
  label?: string;      // text of the cell just before it (key/value tables)
}

export interface AXNode {
  role: string;          // "textbox", "button", "cell", "link", "table", etc.
  name: string;         // accessible name
  description?: string;  // accessible description (if name is ambiguous)
  value?: string;        // current value (for text inputs)
  children?: AXNode[];
  framePath?: string[];  // which frame this node lives in (empty = main frame)
  backendNodeId?: number;
  context?: NodeContext;  // table context, for row/column/label targets
}

// --- Screen State (output of observe()) ---

export interface ScreenState {
  url: string;
  title: string;
  axTree: AXNode[];        // unified AX tree across all frames
  domSnapshot: string;     // serialized DOM (HTML or simplified)
  screenshotPath?: string;  // path to saved screenshot
  frameUrls: string[];     // URLs of all frames on the page
}

// --- Actions (input to act()) ---

export type { ActionType, TargetSpec } from "../artifact/types.js";
import type { ActionType, TargetSpec } from "../artifact/types.js";

export interface Action {
  type: ActionType;
  target?: TargetSpec;     // which element to act on; params already substituted
  value?: string;          // text to type, option to select, URL to navigate to
  output?: string;         // name of the output to store (for extract)
}

// --- Action Result (output of act()) ---

/**
 * Why an action did not happen. The replay engine maps these to the error
 * taxonomy; the surface only reports what it saw.
 * - element-not-found / ambiguous: the target did not resolve to one element
 * - blocked: something else covers the target (overlay, modal)
 * - not-actionable: found but hidden/disabled/not editable
 * - unexpected-dialog: a native dialog opened; it was dismissed (cancelled)
 * - navigation-failed: the page did not load
 */
export type SurfaceError =
  | "element-not-found"
  | "ambiguous"
  | "blocked"
  | "not-actionable"
  | "unexpected-dialog"
  | "navigation-failed"
  | "invalid-action";

export type ActionResult =
  | { ok: true; extractedValue?: string }
  | { ok: false; error: SurfaceError; detail?: string };

// --- Human operator actions (captured during a handoff) ---

export interface HumanAction {
  action: ActionType;
  target: string;
  timestamp: string;
  result: "success" | "failure";
}

// --- Surface Interface ---

export interface Surface {
  /** Observe the current state of the application surface. */
  observe(): Promise<ScreenState>;

  /** Perform an action on the surface. */
  act(action: Action): Promise<ActionResult>;

  /** Navigate to a URL. */
  navigate(url: string): Promise<ActionResult>;

  /** Close the surface (browser, etc.). */
  close(): Promise<void>;

  /** Expose the live session for human control (CDP endpoint, etc.). */
  exposeSession?(): Promise<{ endpoint: string; token: string } | null>;

  /** Start recording what a human operator does in the live session. */
  startHumanCapture?(): Promise<void>;

  /** Stop recording and return the human's actions (typed values are never kept). */
  stopHumanCapture?(): Promise<HumanAction[]>;
}
