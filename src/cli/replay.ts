/**
 * replay command — deterministically replays a saved artifact.
 */

import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { ReplayEngine } from "../replay/replay-engine.js";
import { EvidenceCollector } from "../evidence/evidence-collector.js";
import { loadConfig } from "../config.js";
import { readFileSync } from "fs";

export async function runReplay(opts: Record<string, any>): Promise<void> {
  const artifactPath = opts.artifact as string;
  const target = opts.target as string;
  const paramsStr = opts.params as string;
  const headed = opts.headed as boolean;

  if (!artifactPath) {
    console.error("Error: --artifact is required for replay");
    console.error('Example: cua replay --artifact ./artifacts/lookup-member-balance/v1.json --params \'{"memberId":"12345"}\'');
    process.exit(1);
  }

  // Load config
  const config = loadConfig(opts.config);

  // Load artifact
  let artifact;
  try {
    const content = readFileSync(artifactPath, "utf-8");
    artifact = JSON.parse(content);
  } catch (e) {
    console.error(`Error loading artifact from ${artifactPath}: ${(e as Error).message}`);
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

  // Set up components — --headed overrides config headless
  const headless = headed ? false : config.headless;
  console.log(`Browser: ${headless ? "headless" : "headed (visible)"}`);

  const surface = new PlaywrightSurface({ headless, screenshotDir: "./evidence/screenshots" });
  await surface._start(target);

  const evidence = new EvidenceCollector("./evidence");

  const engine = new ReplayEngine({
    surface,
    evidenceCollector: evidence,
  });

  console.log(`\nReplaying artifact: ${artifact.capability}`);
  console.log(`Params: ${JSON.stringify(params)}`);
  console.log(`Target: ${target}\n`);

  const result = await engine.run(artifact, params);

  await surface.close();

  console.log(`\n--- Replay Result ---`);
  console.log(`Status: ${result.status}`);

  switch (result.status) {
    case "success":
      console.log(`Outputs: ${JSON.stringify(result.outputs, null, 2)}`);
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
      break;
  }

  console.log(`\nEvidence: ${evidence.runDir}`);
}
