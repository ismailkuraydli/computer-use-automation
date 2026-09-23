/**
 * HumanActionRecorder — records human operator actions during escalation.
 * Per ADR-006: Playwright listener captures clicks/types/navigations.
 */

import type { HumanAction } from "./escalation-request.js";
import type { ActionType } from "../surface/types.js";

export class HumanActionRecorder {
  private _actions: HumanAction[] = [];

  record(action: ActionType, target: string, result: "success" | "failure"): void {
    this._actions.push({
      action,
      target,
      timestamp: new Date().toISOString(),
      result,
    });
  }

  get actions(): HumanAction[] {
    return [...this._actions];
  }

  clear(): void {
    this._actions = [];
  }
}
