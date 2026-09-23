/**
 * Locator types — how the replay engine identifies elements on the page.
 * Per ADR-003: AX-tree-first, DOM fallback, visual last resort.
 */

import { AXNode } from "../surface/types.js";

export interface AXLocator {
  role: string;       // "textbox", "button", "cell", "link"
  name: string;      // accessible name
  description?: string;
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
