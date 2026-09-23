/**
 * LocatorStrategy — resolves a LocatorSpec to a concrete AX node in the current
 * screen state.
 *
 * Per ADR-003: AX-tree-first. Searches the unified AX tree (built by the Surface)
 * for elements matching the specified role and accessible name. If multiple
 * elements match in the same frame, returns "ambiguous" — the caller (replay
 * engine) can then try the DOM fallback.
 *
 * Frame traversal: the AX tree is already unified across frames by the Surface
 * (each node carries a framePath). The locator spec's framePath filters which
 * frame to search in.
 */

import type { AXNode } from "../surface/types.js";
import type { LocatorSpec, ResolveResult } from "./types.js";

/**
 * Flatten the AX tree into a flat array of nodes (with their framePaths preserved).
 */
function flattenAXTree(nodes: AXNode[]): AXNode[] {
  const result: AXNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.children && node.children.length > 0) {
      result.push(...flattenAXTree(node.children));
    }
  }
  return result;
}

/**
 * Check if a node matches an AX locator spec.
 */
function matchesAXLocator(node: AXNode, spec: LocatorSpec): boolean {
  if (node.role !== spec.primary.role) return false;
  if (node.name !== spec.primary.name) return false;
  // If description is specified, match it too (for disambiguation)
  if (spec.primary.description !== undefined) {
    if (node.description !== spec.primary.description) return false;
  }
  // Match frame path if specified
  if (spec.framePath !== undefined) {
    const nodeFrame = node.framePath || [];
    if (spec.framePath.length !== nodeFrame.length) return false;
    for (let i = 0; i < spec.framePath.length; i++) {
      if (spec.framePath[i] !== nodeFrame[i]) return false;
    }
  }
  return true;
}

/**
 * Resolve a locator spec against the current AX tree.
 * Returns the matching node, or an error (not-found / ambiguous).
 */
export function resolveLocator(spec: LocatorSpec, axTree: AXNode[]): ResolveResult {
  const flat = flattenAXTree(axTree);
  const matches = flat.filter((node) => matchesAXLocator(node, spec));

  if (matches.length === 0) {
    return {
      ok: false,
      reason: "not-found",
      detail: `No element found with role="${spec.primary.role}" name="${spec.primary.name}"${spec.framePath ? ` in frame ${spec.framePath.join("/")}` : ""}`,
    };
  }

  if (matches.length > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      detail: `${matches.length} elements found with role="${spec.primary.role}" name="${spec.primary.name}"${spec.framePath ? ` in frame ${spec.framePath.join("/")}` : ""} — use DOM fallback or add description to disambiguate`,
    };
  }

  return { ok: true, node: matches[0] };
}
