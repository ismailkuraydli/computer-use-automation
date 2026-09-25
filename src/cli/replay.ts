/**
 * replay command — deterministically replays a saved artifact and prints the
 * structured result. The work is done by the replay service.
 */

import { replayCapability, ReplayRequestError } from "../app/replay-service.js";
import { TerminalOperatorChannel } from "../escalation/operator-channel.js";
import type { ReplayResult } from "../replay/result.js";
import path from "path";
import type { CliValues } from "./args.js";

export async function runReplay(opts: CliValues): Promise<void> {
  if (!opts.artifact) {
    console.error("Error: --artifact is required for replay");
    console.error('Example: cua replay --artifact artifacts/<capability>/v1.json --params \'{"memberId":"12345"}\'');
    process.exit(2);
  }

  let params: Record<string, unknown>;
  try {
    params = JSON.parse(opts.params ?? "{}");
  } catch (e) {
    console.error(`Error parsing --params JSON: ${(e as Error).message}`);
    process.exit(2);
  }

  try {
    const { result, artifact, profile, evidenceDir } = await replayCapability({
      artifact: opts.artifact,
      params,
      target: opts.target,
      tenant: opts.tenant,
      confirmIrreversible: opts.confirm === true,
      headed: opts.headed === true,
      operator: opts.handoff ? new TerminalOperatorChannel() : undefined,
      configPath: opts.config,
    });
    console.log(`Replayed: ${artifact.capability}${opts.tenant ? ` (tenant ${opts.tenant})` : ""}, app profile ${profile.app}`);
    printResult(result);
    console.log(`\nEvidence: ${path.relative(process.cwd(), evidenceDir)}`);
  } catch (e) {
    if (e instanceof ReplayRequestError) {
      console.error(`Error: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}

function printResult(result: ReplayResult): void {
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
}
