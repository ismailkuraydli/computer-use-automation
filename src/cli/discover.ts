/**
 * discover command — runs the LLM-driven agent loop and saves an artifact.
 */

import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { MockLLMClient } from "../llm/mock-client.js";
import { OpenRouterClient } from "../llm/openrouter-client.js";
import { AgentLoop } from "../discovery/agent-loop.js";
import { Recorder } from "../discovery/recorder.js";
import { SafetyGuard } from "../safety/safety-guard.js";
import { EvidenceCollector } from "../evidence/evidence-collector.js";
import { ArtifactStore } from "../artifact/artifact-store.js";
import { loadConfig, getApiKey } from "../config.js";
import type { AllowlistConfig } from "../artifact/types.js";
import { readFileSync } from "fs";

const DEFAULT_ALLOWLIST: AllowlistConfig = {
  permittedDomains: ["localhost"],
  permittedUrlPatterns: ["/search*", "/detail*", "/new-account*", "/new-account-confirm", "/timeout", "/"],
  permittedActions: ["navigate", "click", "type", "extract", "wait", "submit"],
  riskyActions: ["submit"],
  irreversibleActions: [],
};

export async function runDiscover(opts: Record<string, any>): Promise<void> {
  const goal = opts.goal as string;
  const target = opts.target as string;
  const outputPath = opts.output as string;
  const useMockLLM = opts["mock-llm"] as boolean;
  const headed = opts.headed as boolean;

  if (!goal) {
    console.error("Error: --goal is required for discover");
    console.error('Example: cua discover --goal "Look up member 12345 and read their savings balance"');
    process.exit(1);
  }

  // Load config
  const config = loadConfig(opts.config);

  // Determine LLM client
  let llmClient;
  if (useMockLLM) {
    console.log("Using MockLLMClient (no real API calls)");
    llmClient = new MockLLMClient([
      {
        action: { type: "navigate", value: `${target}/search` },
        reasoning: "Navigate to the member search page",
        goalMet: false,
      },
      {
        action: { type: "type", target: { role: "textbox", name: "Member ID" }, value: "12345" },
        reasoning: "Type the member ID into the search field",
        goalMet: false,
      },
      {
        action: { type: "navigate", value: `${target}/detail?id=12345` },
        reasoning: "Navigate to the member detail page",
        goalMet: false,
      },
      {
        action: { type: "extract", target: { role: "heading", name: "Member Detail - John A. Smith" }, output: "memberName" },
        reasoning: "Extract the member name from the heading",
        goalMet: true,
      },
    ]);
  } else {
    const apiKey = getApiKey(config);
    console.log(`Using ${config.provider} / ${config.model}`);
    llmClient = new OpenRouterClient(apiKey, config);
  }

  // Load allowlist
  let allowlist = DEFAULT_ALLOWLIST;
  if (opts.allowlist) {
    try {
      allowlist = JSON.parse(readFileSync(opts.allowlist, "utf-8"));
    } catch (e) {
      console.error(`Error loading allowlist from ${opts.allowlist}: ${(e as Error).message}`);
      process.exit(1);
    }
  }

  // Set up components — --headed overrides config headless
  const headless = headed ? false : config.headless;
  console.log(`Browser: ${headless ? "headless" : "headed (visible)"}`);

  const surface = new PlaywrightSurface({ headless, screenshotDir: "./evidence/screenshots" });
  await surface._start(target);

  const evidence = new EvidenceCollector("./evidence");
  const recorder = new Recorder("lookup-member-balance", goal, allowlist, [
    { name: "memberId", type: "string", required: true },
  ]);
  const safetyGuard = new SafetyGuard(allowlist);

  const loop = new AgentLoop({
    llmClient,
    surface,
    safetyGuard,
    evidenceCollector: evidence,
    recorder,
    maxSteps: config.maxSteps,
    timeoutMs: config.timeoutMs,
  });

  console.log(`\nGoal: ${goal}`);
  console.log(`Target: ${target}\n`);

  const result = await loop.run(
    goal,
    target,
    [{ name: "memberId", type: "string", required: true }],
    [{ name: "memberName", type: "string" }],
    { outputsExtracted: true }
  );

  await surface.close();

  console.log(`\n--- Discovery Result ---`);
  console.log(`Success: ${result.success}`);
  console.log(`Steps executed: ${result.stepsExecuted}`);
  console.log(`Reason: ${result.reason || "goal met"}`);
  console.log(`Evidence: ${evidence.runDir}`);

  if (result.success) {
    // Save artifact
    const store = new ArtifactStore(outputPath.includes(".json") ? "./artifacts" : outputPath);
    const savedPath = store.save(result.artifact);
    console.log(`Artifact saved: ${savedPath}`);
  }

  console.log(`\nEvidence directory: ${evidence.runDir}`);
}
