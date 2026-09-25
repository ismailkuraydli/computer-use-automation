/**
 * discover command — runs an LLM-driven discovery and saves the artifact.
 * The work is done by the discovery service.
 */

import { discoverCapability, DiscoveryRequestError } from "../app/discovery-service.js";
import { MockLLMClient } from "../llm/mock-client.js";
import path from "path";
import type { CliValues } from "./args.js";

export async function runDiscover(opts: CliValues): Promise<void> {
  if (!opts.goal) {
    console.error("Error: --goal is required for discover");
    console.error('Example: cua discover --goal "Look up member 12345 and read their savings balance" --target http://localhost:3000/search');
    process.exit(2);
  }
  const target = opts.target || process.env.CUA_TARGET_URL || "http://localhost:3000";

  try {
    const outcome = await discoverCapability({
      goal: opts.goal,
      target,
      app: opts.app,
      allowlist: opts.allowlist,
      headed: opts.headed === true,
      configPath: opts.config,
      ...(opts["mock-llm"] ? { llm: () => scriptedLLM(target) } : {}),
    });

    console.log(`\n--- Discovery Result ---`);
    console.log(`Success: ${outcome.success}`);
    console.log(`Steps executed: ${outcome.stepsExecuted}`);
    console.log(`Reason: ${outcome.reason}`);
    if (Object.keys(outcome.outputs).length > 0) console.log(`Outputs: ${JSON.stringify(outcome.outputs, null, 2)}`);
    console.log(`Evidence: ${path.relative(process.cwd(), outcome.evidenceDir)}`);
    if (outcome.selfCheck) console.log(`Self-check replay: ${outcome.selfCheck}`);
    if (outcome.artifactPath) console.log(`Artifact saved: ${path.relative(process.cwd(), outcome.artifactPath)}`);
  } catch (e) {
    if (e instanceof DiscoveryRequestError) {
      console.error(`Error: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}

/** Scripted responses for --mock-llm: no API calls, for trying the pipeline. */
function scriptedLLM(target: string): MockLLMClient {
  const origin = new URL(target).origin;
  console.log("Using MockLLMClient (no real API calls)");
  return new MockLLMClient([
    { action: { type: "navigate", value: `${origin}/search` }, reasoning: "Open member search", goalMet: false },
    {
      action: { type: "type", target: { role: "textbox", name: "Member ID" }, value: "12345" },
      reasoning: "Type the member ID",
      goalMet: false,
    },
    { action: { type: "navigate", value: `${origin}/detail?id=12345` }, reasoning: "Open the member", goalMet: false },
    {
      action: { type: "extract", target: { role: "cell", name: "$12,847.00" }, output: "result" },
      reasoning: "Read the savings balance",
      goalMet: true,
    },
  ]);
}
