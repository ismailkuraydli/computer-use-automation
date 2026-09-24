/**
 * discover command — runs the LLM-driven agent loop and saves an artifact.
 * The LLM plans the capability (name, params, outputs) from the goal.
 */

import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { MockLLMClient } from "../llm/mock-client.js";
import { OpenRouterClient } from "../llm/openrouter-client.js";
import { AgentLoop } from "../discovery/agent-loop.js";
import { Recorder } from "../discovery/recorder.js";
import { SafetyGuard } from "../safety/safety-guard.js";
import { EvidenceCollector } from "../evidence/evidence-collector.js";
import { ArtifactStore } from "../artifact/artifact-store.js";
import { loadConfig, getApiKey, checkModelAccessible } from "../config.js";
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

    console.log("Checking model accessibility...");
    const check = await checkModelAccessible(config);
    if (!check.ok) {
      console.error(`\nModel check failed: ${check.error}`);
      console.error(`\nTo fix:`);
      console.error(`  1. Check .env has the right API key in ${config.apiKeyEnvVar}`);
      console.error(`  2. Check cua.config.json has a valid model name`);
      console.error(`  3. Available models: https://openrouter.ai/models`);
      console.error(`  4. Or run with --mock-llm to skip the real LLM entirely`);
      process.exit(1);
    }
    console.log("Model accessible ✓");

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

  // --- Planning phase: ask the LLM to declare capability name, params, outputs ---
  console.log(`\nPlanning capability from goal...`);
  const planResponse = await llmClient.plan(goal);
  let plan;
  if (planResponse.ok) {
    plan = planResponse.plan;
    console.log(`Capability: ${plan.capability}`);
    console.log(`Params: ${JSON.stringify(plan.params.map(p => p.name))}`);
    console.log(`Outputs: ${JSON.stringify(plan.outputs.map(o => o.name))}`);
    if (plan.subGoals && plan.subGoals.length > 1) {
      console.log(`Sub-goals:`);
      plan.subGoals.forEach(sg => console.log(`  ${sg.id}: ${sg.description}${sg.keywords?.length ? ` (keywords: ${sg.keywords.join(", ")})` : ""}`));
    }
  } else {
    console.error(`Plan failed: ${planResponse.error} — falling back to default`);
    const slug = goal.toLowerCase().replace(/[^a-z0-9\s]/g, "").trim().split(/\s+/).slice(0, 4).join("-");
    plan = {
      capability: slug,
      description: goal,
      params: [{ name: "searchQuery", type: "string" as const, required: true }],
      outputs: [{ name: "result", type: "string" as const }],
    };
    console.log(`Capability: ${plan.capability} (fallback)`);
  }

  // Set up components — create evidence collector first so screenshots go in the run dir
  const headless = headed ? false : config.headless;
  console.log(`\nBrowser: ${headless ? "headless" : "headed (visible)"}`);

  const evidence = new EvidenceCollector("./evidence");

  const surface = new PlaywrightSurface({ headless, screenshotDir: evidence.screenshotDir });
  await surface._start(target);

  const recorder = new Recorder(plan.capability, plan.description, allowlist, plan.params, plan.outputs);
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
    plan.params,
    plan.outputs,
    { outputsExtracted: true },
    plan.subGoals || []
  );

  await surface.close();

  console.log(`\n--- Discovery Result ---`);
  console.log(`Success: ${result.success}`);
  console.log(`Steps executed: ${result.stepsExecuted}`);
  console.log(`Reason: ${result.reason || "goal met"}`);
  if (result.outputs && Object.keys(result.outputs).length > 0) {
    console.log(`Outputs: ${JSON.stringify(result.outputs, null, 2)}`);
  }
  console.log(`Evidence: ${evidence.runDir}`);

  if (result.success) {
    const store = new ArtifactStore(outputPath.includes(".json") ? "./artifacts" : outputPath);
    const savedPath = store.save(result.artifact);
    console.log(`Artifact saved: ${savedPath}`);
  }

  console.log(`\nEvidence directory: ${evidence.runDir}`);
}
