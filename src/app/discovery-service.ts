/**
 * Discovery service — one LLM-driven discovery run, shared by the CLI and the
 * MCP server: plan the capability, drive the app, record the artifact,
 * replay it once as a self-check, save it to the workspace.
 */

import { readFileSync } from "fs";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { OpenRouterClient } from "../llm/openrouter-client.js";
import type { LLMClient } from "../llm/types.js";
import { AgentLoop } from "../discovery/agent-loop.js";
import { Recorder } from "../discovery/recorder.js";
import { ReplayEngine } from "../replay/replay-engine.js";
import { SensitiveDataRedactor } from "../safety/sensitive-data.js";
import { SafetyGuard } from "../safety/safety-guard.js";
import { EvidenceCollector } from "../evidence/evidence-collector.js";
import { ArtifactStore } from "../artifact/artifact-store.js";
import type { AllowlistConfig, CapabilityArtifact } from "../artifact/types.js";
import type { AppProfile } from "../artifact/profile-types.js";
import { loadConfig, getApiKey, checkModelAccessible, type CuaConfig } from "../config.js";
import { resolveWorkspace, loadWorkspaceProfile, findDataFile, SAFE_NAME, type Workspace } from "./workspace.js";
import path from "path";

export interface DiscoveryRequest {
  goal: string;
  target: string;
  /** App profile name; stored in the artifact. */
  app?: string;
  /** An allowlist, a path to one, or an allowlist name in allowlists/<name>.json. */
  allowlist?: AllowlistConfig | string;
  headed?: boolean;
  /** Build the model client; defaults to OpenRouter from cua.config.json. */
  llm?: (redactor: SensitiveDataRedactor, config: CuaConfig) => LLMClient | Promise<LLMClient>;
  workspace?: Workspace;
  configPath?: string;
  log?: (line: string) => void;
}

export interface DiscoveryOutcome {
  success: boolean;
  reason: string;
  stepsExecuted: number;
  capability: string;
  outputs: Record<string, string>;
  artifact?: CapabilityArtifact;
  artifactPath?: string;
  selfCheck?: string;
  evidenceDir: string;
}

export class DiscoveryRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiscoveryRequestError";
  }
}

export async function discoverCapability(req: DiscoveryRequest): Promise<DiscoveryOutcome> {
  const log = req.log ?? ((line: string) => console.log(line));
  const ws = req.workspace ?? resolveWorkspace();
  const config = loadConfig(req.configPath);
  if (!req.goal?.trim()) throw new DiscoveryRequestError("goal is required");
  if (!isHttpUrl(req.target)) throw new DiscoveryRequestError(`target must be an http(s) URL, got "${req.target}"`);

  let profile: AppProfile;
  let allowlist: AllowlistConfig;
  try {
    profile = loadWorkspaceProfile(ws, req.app);
    allowlist = resolveAllowlist(ws, req.allowlist, req.target);
  } catch (e) {
    throw new DiscoveryRequestError((e as Error).message);
  }

  // One redactor per run, from the app profile: it learns sensitive values
  // as screens are observed and scrubs them from LLM prompts, evidence,
  // screenshots and the saved artifact.
  const redactor = new SensitiveDataRedactor(profile.sensitive);
  const llm = await (req.llm ?? defaultLLM)(redactor, config);

  log("Planning capability from goal...");
  const planned = await llm.plan(req.goal);
  const plan = planned.ok ? planned.plan : fallbackPlan(req.goal);
  log(`Capability: ${plan.capability} — params ${JSON.stringify(plan.params.map((p) => p.name))}, outputs ${JSON.stringify(plan.outputs.map((o) => o.name))}`);

  const headless = req.headed ? false : config.headless;
  const evidence = new EvidenceCollector(ws.evidenceDir, redactor);
  const surface = new PlaywrightSurface({ headless, screenshotDir: evidence.screenshotDir, redactor });
  const recorder = new Recorder({
    capability: plan.capability,
    description: plan.description,
    allowlist,
    params: plan.params,
    outputs: plan.outputs,
    paramValues: plan.paramValues || {},
    goal: req.goal,
    app: req.app,
  });

  let result;
  try {
    await surface._start(req.target);
    const loop = new AgentLoop({
      llmClient: llm,
      surface,
      safetyGuard: new SafetyGuard(allowlist),
      evidenceCollector: evidence,
      recorder,
      maxSteps: config.maxSteps,
      timeoutMs: config.timeoutMs,
    });
    result = await loop.run(req.goal, req.target, plan.params, plan.outputs, { outputsExtracted: true }, plan.subGoals || []);
  } finally {
    await surface.close();
  }

  const outcome: DiscoveryOutcome = {
    success: result.success,
    reason: result.reason || "goal met",
    stepsExecuted: result.stepsExecuted,
    capability: plan.capability,
    outputs: redactor.redactDeep(result.outputs ?? {}),
    evidenceDir: evidence.runDir,
  };
  if (!result.success) return outcome;

  const selfCheck = await selfCheckReplay(result.artifact, recorder.discoveryParams, headless, redactor, profile, ws);
  const artifact = { ...result.artifact, metadata: { ...result.artifact.metadata, selfCheck } };
  const artifactPath = new ArtifactStore(ws.artifactsDir).save(artifact, redactor);
  return { ...outcome, artifact, artifactPath, selfCheck };
}

async function defaultLLM(redactor: SensitiveDataRedactor, config: CuaConfig): Promise<LLMClient> {
  const apiKey = getApiKey(config);
  const check = await checkModelAccessible(config);
  if (!check.ok) throw new DiscoveryRequestError(`Model check failed: ${check.error}`);
  return new OpenRouterClient(apiKey, config, redactor);
}

/**
 * Default allowlist when none is given: the target's own host only, every
 * action type, submit flagged as risky. It is stored in the artifact, so it
 * also bounds every replay.
 */
export function defaultAllowlist(target: string): AllowlistConfig {
  return {
    permittedDomains: [new URL(target).hostname],
    permittedUrlPatterns: ["/*"],
    permittedActions: ["navigate", "click", "type", "select", "extract", "wait", "submit", "scroll", "read_page_text"],
    riskyActions: ["submit"],
    irreversibleActions: [],
  };
}

function resolveAllowlist(ws: Workspace, allowlist: DiscoveryRequest["allowlist"], target: string): AllowlistConfig {
  if (!allowlist) return defaultAllowlist(target);
  if (typeof allowlist === "object") return allowlist;
  // A bare name refers to allowlists/<name>.json (workspace first, then bundled)
  const file = SAFE_NAME.test(allowlist) ? findDataFile(ws, path.join("allowlists", `${allowlist}.json`)) : allowlist;
  if (!file) throw new Error(`No allowlist named "${allowlist}"`);
  return JSON.parse(readFileSync(file, "utf-8")) as AllowlistConfig;
}

function fallbackPlan(goal: string) {
  const slug = goal.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().split(/\s+/).slice(0, 4).join("-");
  return {
    capability: slug,
    description: goal,
    params: [{ name: "searchQuery", type: "string" as const, required: true }],
    outputs: [{ name: "result", type: "string" as const }],
    subGoals: [],
    paramValues: {},
  };
}

/**
 * Replay the fresh artifact once with the discovery params, so a capability
 * that cannot replay is flagged before any agent relies on it. Artifacts with
 * irreversible steps are not replayed: that would repeat the real action.
 */
async function selfCheckReplay(
  artifact: CapabilityArtifact,
  params: Record<string, string>,
  headless: boolean,
  redactor: SensitiveDataRedactor,
  profile: AppProfile,
  ws: Workspace
): Promise<string> {
  if (artifact.steps.some((s) => s.classification === "irreversible")) {
    return "skipped: artifact has irreversible steps";
  }
  const evidence = new EvidenceCollector(ws.evidenceDir, redactor);
  const surface = new PlaywrightSurface({ headless, screenshotDir: evidence.screenshotDir, redactor });
  try {
    await surface._start();
    const result = await new ReplayEngine({ surface, evidenceCollector: evidence, profile }).run(artifact, params);
    // Stored in the artifact: keep it relative so it does not leak local paths
    const where = path.relative(ws.root, evidence.runDir);
    return result.status === "success" ? `passed (${where})` : `failed: ${result.status} (${where})`;
  } catch (e) {
    return `failed: ${(e as Error).message}`;
  } finally {
    await surface.close();
  }
}

function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
