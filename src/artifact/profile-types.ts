/**
 * App profile — the runtime conditions every screen of one application can
 * show, shared by all artifacts recorded against it.
 *
 * This is where site knowledge goes. A new popup or error page is handled by
 * adding an entry here (or escalating to a human, whose action can be
 * promoted into the profile) — never by changing engine code. Tenants running
 * the same vendor product share one profile; per-tenant differences become an
 * overlay profile merged on top.
 */

import type { ErrorHandler, StateGuard, TargetSpec } from "./types.js";
import type { SensitiveDataSpec } from "../safety/sensitive-data.js";

export const PROFILE_SCHEMA_VERSION = "1.0";

/** A known screen that blocks the flow and is safe to dismiss. */
export interface Interstitial {
  name: string;
  when: StateGuard;
  dismiss: TargetSpec;
}

export interface AppProfile {
  schemaVersion: string;
  app: string;
  version: number;
  description?: string;
  interstitials: Interstitial[];
  conditions: ErrorHandler[];
  /** Where regulated data sits on this app's screens (names, dates of birth...). */
  sensitive?: SensitiveDataSpec;
}

export const EMPTY_PROFILE: AppProfile = {
  schemaVersion: PROFILE_SCHEMA_VERSION,
  app: "none",
  version: 0,
  interstitials: [],
  conditions: [],
};
