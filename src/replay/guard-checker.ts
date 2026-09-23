/**
 * GuardChecker — checks whether a StateGuard matches the current ScreenState.
 * Per ADR-002: guards detect runtime errors before and after each step.
 */

import type { ScreenState, AXNode } from "../surface/types.js";
import type { StateGuard, ScreenSignature } from "../artifact/types.js";
import type { AXLocator } from "../locator/types.js";

export class GuardChecker {
  static check(guard: StateGuard | undefined, state: ScreenState): boolean {
    if (!guard) return true;

    // anyOf: at least one signature must match
    if (guard.anyOf) {
      return guard.anyOf.some((sig) => GuardChecker._matchSignature(sig, state));
    }

    // allOf: all signatures must match
    if (guard.allOf) {
      return guard.allOf.every((sig) => GuardChecker._matchSignature(sig, state));
    }

    // expect: page-level state
    if (guard.expect === "loaded") {
      return state.axTree.length > 0;
    }
    if (guard.expect === "unloaded") {
      return state.axTree.length === 0;
    }

    return true;
  }

  private static _matchSignature(sig: ScreenSignature, state: ScreenState): boolean {
    // Check AX elements
    if (sig.axContains) {
      for (const locator of sig.axContains) {
        if (!GuardChecker._hasAXElement(state.axTree, locator)) {
          return false;
        }
      }
    }

    // Check URL pattern
    if (sig.urlPattern) {
      try {
        const parsedUrl = new URL(state.url);
        const path = parsedUrl.pathname + parsedUrl.search;
        const regex = sig.urlPattern
          .replace(/[.+^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*");
        if (!new RegExp(regex).test(path)) return false;
      } catch {
        if (!state.url.includes(sig.urlPattern)) return false;
      }
    }

    // Check text contains
    if (sig.textContains) {
      const allText = state.axTree.map((n) => n.name).join(" ");
      if (!allText.includes(sig.textContains)) return false;
    }

    return true;
  }

  private static _hasAXElement(tree: AXNode[], locator: AXLocator): boolean {
    return tree.some((n) => n.role === locator.role && n.name === locator.name);
  }
}
