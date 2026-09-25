/**
 * Replay service — one deterministic replay, shared by the CLI and the MCP
 * server. Loads and validates the artifact, its app profile (and a tenant
 * overlay when given), runs the ReplayEngine on a fresh browser, and always
 * closes the browser.
 */

import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { ReplayEngine } from "../replay/replay-engine.js";
import type { ReplayResult } from "../replay/result.js";
import { EvidenceCollector } from "../evidence/evidence-collector.js";
import { loadConfig } from "../config.js";
import { loadArtifactFile } from "../artifact/artifact-store.js";
import type { CapabilityArtifact } from "../artifact/types.js";
import type { AppProfile } from "../artifact/profile-types.js";
import { SensitiveDataRedactor } from "../safety/sensitive-data.js";
import { EscalationManager } from "../escalation/escalation-manager.js";
import type { OperatorChannel } from "../escalation/operator-channel.js";
import { resolveWorkspace, loadWorkspaceProfile, type Workspace } from "./workspace.js";
import { loadTenantOverlay, applyTenantOverlay } from "../artifact/tenant-overlay.js";
import { existsSync } from "fs";

/** CDP port exposed during a handoff so an operator can also attach remotely. */
const HANDOFF_DEBUG_PORT = 9222;

export interface ReplayRequest {
  /** An artifact, or the path of an artifact file. */
  artifact: CapabilityArtifact | string;
  params: Record<string, unknown>;
  /** Page to open before the first step (the first step usually navigates anyway). */
  target?: string;
  /** Tenant overlay name, from profiles/tenants/<app>/<tenant>.json. */
  tenant?: string;
  confirmIrreversible?: boolean;
  headed?: boolean;
  /** Hand the live session to this operator on escalation (implies headed). */
  operator?: OperatorChannel;
  workspace?: Workspace;
  configPath?: string;
}

export interface ReplayOutcome {
  result: ReplayResult;
  /** The artifact as replayed (after the tenant overlay). */
  artifact: CapabilityArtifact;
  profile: AppProfile;
  evidenceDir: string;
}

/** A problem with the request itself (bad artifact, profile, tenant, params). */
export class ReplayRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReplayRequestError";
  }
}

export async function replayCapability(req: ReplayRequest): Promise<ReplayOutcome> {
  const ws = req.workspace ?? resolveWorkspace();
  const { artifact, profile } = prepare(req, ws);
  const params = normalizeParams(artifact, req.params);

  const config = loadConfig(req.configPath);
  const headless = req.headed || req.operator ? false : config.headless;

  // One redactor per run: it learns sensitive values as screens are observed
  // and scrubs them from evidence, screenshots and everything written.
  const redactor = new SensitiveDataRedactor(profile.sensitive);
  const evidence = new EvidenceCollector(ws.evidenceDir, redactor);
  const surface = new PlaywrightSurface({
    headless,
    screenshotDir: evidence.screenshotDir,
    redactor,
    ...(req.operator ? { remoteDebuggingPort: HANDOFF_DEBUG_PORT } : {}),
  });

  try {
    await surface._start(req.target);
    const engine = new ReplayEngine({
      surface,
      evidenceCollector: evidence,
      profile,
      ...(req.operator ? { handoff: new EscalationManager(surface, evidence, req.operator) } : {}),
    });
    const result = await engine.run(artifact, params, { confirmIrreversible: req.confirmIrreversible === true });
    return { result, artifact, profile, evidenceDir: evidence.runDir };
  } finally {
    await surface.close();
  }
}

function prepare(req: ReplayRequest, ws: Workspace): { artifact: CapabilityArtifact; profile: AppProfile } {
  let artifact: CapabilityArtifact;
  let profile: AppProfile;
  try {
    if (typeof req.artifact === "string" && !existsSync(req.artifact)) {
      throw new Error(`Artifact file not found: ${req.artifact}`);
    }
    artifact = typeof req.artifact === "string" ? loadArtifactFile(req.artifact) : req.artifact;
    profile = loadWorkspaceProfile(ws, artifact.surface.app);
    if (req.tenant) {
      const overlay = loadTenantOverlay(ws, artifact.surface.app, req.tenant);
      ({ artifact, profile } = applyTenantOverlay(artifact, profile, overlay));
    }
  } catch (e) {
    throw new ReplayRequestError((e as Error).message);
  }
  return { artifact, profile };
}

/**
 * Match caller keys to declared params ignoring case, "-" and "_", and turn
 * values into strings (they are substituted into text).
 */
function normalizeParams(artifact: CapabilityArtifact, input: Record<string, unknown>): Record<string, string> {
  const normalize = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    const declared = artifact.params.find((p) => normalize(p.name) === normalize(key));
    params[declared ? declared.name : key] = String(value);
  }
  return params;
}
