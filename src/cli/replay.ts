/**
 * replay command — deterministically replays a saved artifact.
 */

import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { ReplayEngine } from "../replay/replay-engine.js";
import { EvidenceCollector } from "../evidence/evidence-collector.js";
import { loadConfig } from "../config.js";
import { loadArtifactFile } from "../artifact/artifact-store.js";
import { loadProfile } from "../artifact/profile-store.js";
import { SensitiveDataRedactor } from "../safety/sensitive-data.js";
import { EscalationManager } from "../escalation/escalation-manager.js";
import { TerminalOperatorChannel } from "../escalation/operator-channel.js";

/** CDP port exposed during --handoff so an operator can also attach remotely. */
const HANDOFF_DEBUG_PORT = 9222;

export async function runReplay(opts: Record<string, any>): Promise<void> {
  const artifactPath = opts.artifact as string;
  const target = opts.target as string;
  const paramsStr = opts.params as string;
  const handoff = opts.handoff === true;
  const headed = (opts.headed as boolean) || handoff;

  if (!artifactPath) {
    console.error("Error: --artifact is required for replay");
    console.error('Example: cua replay --artifact ./artifacts/lookup-member-balance/v1.json --params \'{"memberId":"12345"}\'');
    process.exit(1);
  }

  // Load config
  const config = loadConfig(opts.config);

  // Load artifact (validated and migrated to the current schema) and its app profile
  let artifact;
  let profile;
  try {
    artifact = loadArtifactFile(artifactPath);
    profile = loadProfile(artifact.surface.app);
  } catch (e) {
    console.error(`Error loading ${artifactPath}: ${(e as Error).message}`);
    process.exit(1);
  }

  // Parse params
  let params: Record<string, string> = {};
  try {
    params = JSON.parse(paramsStr);
  } catch (e) {
    console.error(`Error parsing --params JSON: ${(e as Error).message}`);
    process.exit(1);
  }

  // Set up components — create evidence collector first so screenshots go in the run dir
  const headless = headed ? false : config.headless;
  console.log(`Browser: ${headless ? "headless" : "headed (visible)"}`);

  // One redactor per run: it learns sensitive values as screens are observed
  // and scrubs them from evidence, screenshots and everything written.
  const redactor = new SensitiveDataRedactor(profile.sensitive);
  const evidence = new EvidenceCollector("./evidence", redactor);

  const surface = new PlaywrightSurface({
    headless,
    screenshotDir: evidence.screenshotDir,
    redactor,
    ...(handoff ? { remoteDebuggingPort: HANDOFF_DEBUG_PORT } : {}),
  });
  await surface._start(target);

  const engine = new ReplayEngine({
    surface,
    evidenceCollector: evidence,
    profile,
    ...(handoff ? { handoff: new EscalationManager(surface, evidence, new TerminalOperatorChannel()) } : {}),
  });

  console.log(`\nReplaying artifact: ${artifact.capability}`);
  console.log(`Params expected: ${JSON.stringify(artifact.params.map((p) => p.name))}`);
  console.log(`App profile: ${profile.app}`);
  console.log(`Params provided: ${JSON.stringify(params)}`);
  console.log(`Target: ${target}\n`);

  // Normalize param keys: if the caller provides params with different casing/hyphens,
  // match them to the artifact's declared param names
  const normalize = (s: string) => s.toLowerCase().replace(/[-_]/g, "");
  const normalizedParams: Record<string, string> = {};
  for (const [key, val] of Object.entries(params)) {
    const match = artifact.params.find((p) => normalize(p.name) === normalize(key));
    normalizedParams[match ? match.name : key] = val;
  }
  params = normalizedParams;

  const result = await engine.run(artifact, params, { confirmIrreversible: opts.confirm === true });

  await surface.close();

  console.log(`\n--- Replay Result ---`);
  console.log(`Status: ${result.status}`);

  switch (result.status) {
    case "success":
      console.log(`Outputs: ${JSON.stringify(result.outputs, null, 2)}`);
      if (result.humanActions) console.log(`Human actions: ${JSON.stringify(result.humanActions, null, 2)}`);
      break;
    case "business-outcome":
      console.log(`Outcome: ${result.outcome}`);
      console.log(`Detail: ${result.detail}`);
      break;
    case "failure":
      console.log(`Step: ${result.stepId}`);
      console.log(`Expected: ${result.expected}`);
      console.log(`Observed: ${result.observed}`);
      console.log(`Error: ${result.error}`);
      break;
    case "escalated":
      console.log(`Step: ${result.stepId}`);
      console.log(`Reason: ${result.reason}`);
      console.log(`Resolution: ${result.resolution}`);
      if (result.humanActions) console.log(`Human actions: ${JSON.stringify(result.humanActions, null, 2)}`);
      break;
  }

  console.log(`\nEvidence: ${evidence.runDir}`);
}
