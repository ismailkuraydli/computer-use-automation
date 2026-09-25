/**
 * ErrorClassifier — which known runtime condition, if any, is on screen.
 *
 * Handlers are checked in order (step-specific first, then the app profile);
 * the first match wins. No match means the state is unknown — the replay
 * engine decides between escalation and hard failure.
 */

import type { ScreenState } from "../surface/types.js";
import type { ErrorHandler } from "../artifact/types.js";
import type { Interstitial } from "../artifact/profile-types.js";
import { GuardChecker } from "./guard-checker.js";

export class ErrorClassifier {
  static classify(state: ScreenState, handlers: ErrorHandler[]): ErrorHandler | null {
    return handlers.find((h) => GuardChecker.check(h.when, state)) ?? null;
  }

  static interstitial(state: ScreenState, interstitials: Interstitial[]): Interstitial | null {
    return interstitials.find((i) => GuardChecker.check(i.when, state)) ?? null;
  }
}
