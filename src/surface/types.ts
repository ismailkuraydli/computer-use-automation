/**
 * Surface types — the interface between the automation system and the
 * target application. Surface-agnostic: never leaks Playwright types.
 * Per ADR-008: this interface is the seam that enables extending to
 * desktop surfaces without changing the artifact schema or replay engine.
 */

// --- AX Tree types ---

export interface AXNode {
  role: string;          // "textbox", "button", "cell", "link", "table", etc.
  name: string;         // accessible name
  description?: string;  // accessible description (if name is ambiguous)
  value?: string;        // current value (for text inputs)
  children?: AXNode[];
  framePath?: string[];  // which frame this node lives in (empty = main frame)
  // Backend-specific handle for acting on this element (opaque to callers)
  // In PlaywrightSurface, this is the element handle — but the type is generic
  // so it doesn't leak Playwright types into the interface.
  backendNodeId?: number;
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

export type ActionType = "navigate" | "click" | "type" | "extract" | "wait" | "submit" | "scroll" | "read_page_text";

export interface Action {
  type: ActionType;
  target?: AXNode;         // which element to act on (for click/type/extract/submit)
  value?: string;          // text to type, URL to navigate to, etc.
  output?: string;         // name of the output to store (for extract)
}

// --- Action Result (output of act()) ---

export type ActionResult =
  | { ok: true; extractedValue?: string }
  | { ok: false; error: string; detail?: string };

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
  exposeSession?(): Promise<{ endpoint: string; token: string }>;
}
