/**
 * SafetyGuard — enforces allowlist, classifies actions, routes irreversible to escalation.
 * Per ADR-005: allowlist + safe/risky/irreversible action classification.
 */

import type { AllowlistConfig, ActionType } from "../artifact/types.js";
import type { Action } from "../surface/types.js";

export type SafetyResult = {
  allowed: boolean;
  classification: "safe" | "risky" | "irreversible";
  flagged: boolean;       // true for risky actions (allowed but flagged in evidence)
  escalate: boolean;      // true for irreversible actions (blocked, route to escalation)
  reason?: string;
};

export class SafetyGuard {
  private allowlist: AllowlistConfig;

  constructor(allowlist: AllowlistConfig) {
    this.allowlist = allowlist;
  }

  check(action: Action, _currentUrl: string): SafetyResult {
    const actionType = action.type as ActionType;

    // Check if action type is permitted
    const isPermitted = this.allowlist.permittedActions.includes(actionType);
    const isRisky = this.allowlist.riskyActions?.includes(actionType) ?? false;
    const isIrreversible = this.allowlist.irreversibleActions?.includes(actionType) ?? false;

    // Irreversible actions are blocked and routed to escalation
    if (isIrreversible) {
      return {
        allowed: false,
        classification: "irreversible",
        flagged: true,
        escalate: true,
        reason: `Action type "${actionType}" is irreversible — escalation required`,
      };
    }

    // Check if action type is in permitted or risky list
    if (!isPermitted && !isRisky) {
      return {
        allowed: false,
        classification: "safe",
        flagged: false,
        escalate: false,
        reason: `Action type "${actionType}" is not permitted by the allowlist`,
      };
    }

    // For navigate actions, check URL against allowlist
    if (actionType === "navigate" && action.value) {
      const urlCheck = this._checkUrl(action.value);
      if (!urlCheck.allowed) {
        return {
          allowed: false,
          classification: isRisky ? "risky" : "safe",
          flagged: false,
          escalate: false,
          reason: urlCheck.reason,
        };
      }
    }

    // Risky actions are allowed but flagged
    if (isRisky) {
      return {
        allowed: true,
        classification: "risky",
        flagged: true,
        escalate: false,
      };
    }

    // Safe actions
    return {
      allowed: true,
      classification: "safe",
      flagged: false,
      escalate: false,
    };
  }

  private _checkUrl(url: string): { allowed: boolean; reason?: string } {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return { allowed: false, reason: `Invalid URL: ${url}` };
    }

    // Check domain
    const domain = parsedUrl.hostname;
    if (!this.allowlist.permittedDomains.includes(domain)) {
      return { allowed: false, reason: `Domain "${domain}" not in permitted domains` };
    }

    // Check URL pattern
    const path = parsedUrl.pathname + parsedUrl.search;
    const matches = this.allowlist.permittedUrlPatterns.some((pattern) => {
      return this._matchPattern(path, pattern);
    });

    if (!matches) {
      return { allowed: false, reason: `URL path "${path}" not permitted by allowlist patterns` };
    }

    return { allowed: true };
  }

  private _matchPattern(path: string, pattern: string): boolean {
    // Convert glob pattern to regex: * matches anything
    // Don't escape ? in path (it's a query separator, not a regex quantifier)
    const regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    return new RegExp(`^${regex}`).test(path);
  }
}
