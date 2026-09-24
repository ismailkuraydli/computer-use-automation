/**
 * Locator types — how the replay engine identifies elements on the page.
 * Per ADR-003: AX-tree-first, DOM fallback, visual last resort.
 */

import { AXNode } from "../surface/types.js";

export interface AXLocator {
  role: string;       // "textbox", "button", "cell", "link"
  name: string;      // accessible name
  description?: string;
  // Exact element identity (Change 3) — captured during discovery,
  // used by replay for precise element resolution
  cssSelector?: string;   // unique CSS selector
  id?: string;            // element id attribute
  ariaLabel?: string;     // aria-label attribute
  text?: string;          // trimmed text content (first 100 chars)
  href?: string;          // for links
  dataTestId?: string;    // data-testid attribute
}

export interface DOMLocator {
  selector: string;     // CSS selector (structural, not ID-based)
  text?: string;         // text content for disambiguation
  position?: { index: number }; // nth match if multiple
}

export interface VisualLocator {
  region: { x: number; y: number; w: number; h: number };
  description: string;
}

export interface LocatorSpec {
  primary: AXLocator;          // AX-tree-first
  fallback?: DOMLocator;        // DOM structural fallback
  visual?: VisualLocator;       // screenshot region (last resort)
  framePath?: string[];         // path through frame tree
}

export type ResolveResult =
  | { ok: true; node: AXNode }
  | { ok: false; reason: "not-found" | "ambiguous"; detail: string };
