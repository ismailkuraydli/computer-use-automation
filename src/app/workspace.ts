/**
 * Workspace — where a run reads and writes its data.
 *
 * Artifacts and evidence live in the workspace (`CUA_WORKSPACE`, else the
 * current directory). Profiles and allowlists are looked up in the workspace
 * first and then in the ones shipped with this package, so an installed
 * plugin works out of the box and a team can override per workspace.
 */

import { existsSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { loadProfile } from "../artifact/profile-store.js";
import type { AppProfile } from "../artifact/profile-types.js";

/** Root of this package (the plugin root when installed as a plugin). */
export const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/** Names used to build data paths (apps, tenants, capabilities) — never paths. */
export const SAFE_NAME = /^[\w-]+$/;

export interface Workspace {
  root: string;
  artifactsDir: string;
  evidenceDir: string;
}

export function resolveWorkspace(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Workspace {
  const root = path.resolve(env.CUA_WORKSPACE || cwd);
  return {
    root,
    artifactsDir: path.join(root, "artifacts"),
    evidenceDir: path.join(root, "evidence"),
  };
}

/** First existing file among the workspace copy and the bundled copy. */
export function findDataFile(ws: Workspace, relative: string): string | undefined {
  return [path.join(ws.root, relative), path.join(PACKAGE_ROOT, relative)].find((p) => existsSync(p));
}

export function loadWorkspaceProfile(ws: Workspace, app: string | undefined): AppProfile {
  // Unsafe names go straight to loadProfile, which rejects them before any path use
  if (!app || !SAFE_NAME.test(app)) return loadProfile(app);
  const file = findDataFile(ws, path.join("profiles", `${app}.json`));
  // Let loadProfile validate the name and report the missing file
  return loadProfile(app, file ? path.dirname(file) : path.join(ws.root, "profiles"));
}
