/**
 * Loads app profiles from ./profiles/<app>.json and validates their shape.
 */

import { existsSync, readFileSync } from "fs";
import path from "path";
import { EMPTY_PROFILE, type AppProfile } from "./profile-types.js";

const CONDITION_KINDS = new Set(["business-outcome", "retry", "escalate", "hard-failure"]);

export class ProfileValidationError extends Error {
  constructor(message: string) {
    super(`Invalid app profile: ${message}`);
    this.name = "ProfileValidationError";
  }
}

export function loadProfile(app: string | undefined, dir = "./profiles"): AppProfile {
  if (!app) return EMPTY_PROFILE;
  if (!/^[\w-]+$/.test(app)) throw new ProfileValidationError(`bad app name "${app}"`);

  const file = path.join(dir, `${app}.json`);
  if (!existsSync(file)) throw new ProfileValidationError(`no profile at ${file}`);
  return validateProfile(JSON.parse(readFileSync(file, "utf-8")));
}

export function validateProfile(raw: unknown): AppProfile {
  if (typeof raw !== "object" || raw === null) throw new ProfileValidationError("not a JSON object");
  const profile = raw as AppProfile;
  if (typeof profile.app !== "string") throw new ProfileValidationError('missing "app"');
  if (!Array.isArray(profile.interstitials) || !Array.isArray(profile.conditions)) {
    throw new ProfileValidationError('"interstitials" and "conditions" must be arrays');
  }
  for (const i of profile.interstitials) {
    if (!i.when || !i.dismiss?.role) throw new ProfileValidationError(`interstitial "${i.name}" needs when + dismiss`);
  }
  for (const c of profile.conditions) {
    if (!c.when || !CONDITION_KINDS.has(c.kind)) {
      throw new ProfileValidationError(`condition "${c.description}" has invalid kind "${c.kind}"`);
    }
  }
  return profile;
}
