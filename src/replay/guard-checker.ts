/**
 * GuardChecker — does a StateGuard / ScreenSignature match a ScreenState?
 * Params must already be substituted. Element names match whole-text and
 * case-insensitively; text and URL patterns match case-insensitively.
 */

import type { ScreenState, AXNode } from "../surface/types.js";
import type { StateGuard, ScreenSignature, ElementRef } from "../artifact/types.js";

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export class GuardChecker {
  static check(guard: StateGuard | undefined, state: ScreenState): boolean {
    if (!guard) return true;
    if (guard.anyOf && !guard.anyOf.some((sig) => GuardChecker.matches(sig, state))) return false;
    if (guard.allOf && !guard.allOf.every((sig) => GuardChecker.matches(sig, state))) return false;
    return true;
  }

  static matches(sig: ScreenSignature, state: ScreenState): boolean {
    if (sig.axContains && !sig.axContains.every((ref) => hasElement(state.axTree, ref))) return false;
    if (sig.urlPattern && !matchesUrl(sig.urlPattern, state.url)) return false;
    if (sig.textContains && !pageText(state).includes(norm(sig.textContains))) return false;
    return true;
  }
}

function hasElement(tree: AXNode[], ref: ElementRef): boolean {
  const name = norm(ref.name);
  return tree.some((n) => n.role === ref.role && norm(n.name) === name);
}

function pageText(state: ScreenState): string {
  return norm(state.axTree.map((n) => n.name).join(" "));
}

/** `*` is a wildcard; matched against path + query, case-insensitively. */
function matchesUrl(pattern: string, url: string): boolean {
  let target = url;
  try {
    const parsed = new URL(url);
    target = parsed.pathname + parsed.search;
  } catch {
    // not an absolute URL — match against it as-is
  }
  const regex = pattern.replace(/[.+^${}()|[\]\\?]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(regex, "i").test(target);
}
