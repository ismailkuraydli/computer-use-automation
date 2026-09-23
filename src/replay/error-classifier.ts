/**
 * ErrorClassifier — three-tier error taxonomy.
 * Per ADR-004: business outcome / recoverable / hard failure.
 */

import type { ScreenState } from "../surface/types.js";
import type { ErrorHandler } from "../artifact/types.js";
import { GuardChecker } from "./guard-checker.js";

export type ErrorTier = "business-outcome" | "recoverable" | "hard-failure" | "escalate";

export interface ErrorClassification {
  tier: ErrorTier;
  handler?: "retry" | "dismiss" | "wait" | "fail" | "escalate";
  maxRetries?: number;
  outcome?: string;
  reason: string;
}

export class ErrorClassifier {
  /**
   * Classify the current page state against the step's error handlers.
   * Returns the first matching handler's classification, or a hard failure
   * if no handler matches.
   */
  static classify(state: ScreenState, handlers: ErrorHandler[]): ErrorClassification {
    // Check each handler in order — first match wins
    for (const handler of handlers) {
      if (GuardChecker.check(handler.when, state)) {
        switch (handler.handler) {
          case "fail":
            return {
              tier: "business-outcome",
              handler: "fail",
              outcome: handler.outcome || "unknown",
              reason: handler.description || `Business outcome: ${handler.outcome}`,
            };
          case "retry":
          case "wait":
            return {
              tier: "recoverable",
              handler: handler.handler,
              maxRetries: handler.maxRetries || 1,
              reason: handler.description || `Recoverable condition: ${handler.handler}`,
            };
          case "dismiss":
            return {
              tier: "recoverable",
              handler: "dismiss",
              maxRetries: handler.maxRetries || 1,
              reason: handler.description || "Recoverable condition: dismiss dialog",
            };
          case "escalate":
            return {
              tier: "escalate",
              handler: "escalate",
              reason: handler.description || "Escalation required",
            };
        }
      }
    }

    // No handler matched — hard failure
    return {
      tier: "hard-failure",
      reason: `Unhandled error state — no matching error handler for URL ${state.url}`,
    };
  }
}
