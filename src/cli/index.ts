#!/usr/bin/env node
/**
 * cua — Computer-Use Automation CLI
 * Thin wrapper that delegates to existing components.
 */

import { parseCliArgs } from "./args.js";

const parsed = parseCliArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`Error: ${parsed.message}`);
  console.error("Run 'cua --help' for usage.");
  process.exit(2);
}

const { command, values } = parsed;

if (values.help || !command) {
  console.log(`cua — Computer-Use Automation CLI

Usage:
  cua discover --goal "Look up member 12345 and read their savings balance" --target http://localhost:3000/search --app keystone-cu
  cua replay --artifact ./artifacts/lookup-savings-balance/v1.json --params '{"memberId":"23456"}' --target http://localhost:3000

Options:
  --goal       Natural language goal (discover)
  --target     Target URL (default: http://localhost:3000)
  --output     Output path for artifact (discover)
  --artifact   Path to saved artifact JSON (replay)
  --params     JSON string of input parameters (replay)
  --tenant     Tenant overlay from profiles/tenants/<app>/<tenant>.json (replay)
  --base-url   Where the app runs now, e.g. https://bank.example/portal (replay; rebases the artifact)
  --mock-llm   Use MockLLMClient instead of real LLM (discover)
  --headed     Show the browser window (discover, replay)
  --config     Path to cua.config.json (default: ./cua.config.json)
  --allowlist  Path to allowlist JSON file (discover)
  --app        App profile name in ./profiles (discover; stored in the artifact)
  --confirm    Allow the artifact's irreversible steps to run (replay)
  --handoff    On escalation, hand the live browser to you and resume after (replay; implies --headed)
  --help       Show this help

Config (cua.config.json):
  provider, model, baseUrl, apiKeyEnvVar, maxTokens, maxSteps, timeoutMs, headless

Environment:
  OPENROUTER_API_KEY  Required for real LLM discovery (unless --mock-llm)
                      Set via the apiKeyEnvVar in cua.config.json
  CUA_WORKSPACE       Where artifacts and evidence live (default: current directory)

MCP server (for Claude Code / Codex): npm run mcp, or bin/cua-mcp
`);
  process.exit(0);
}

async function main() {
  switch (command) {
    case "discover": {
      const { runDiscover } = await import("./discover.js");
      await runDiscover(values);
      break;
    }
    case "replay": {
      const { runReplay } = await import("./replay.js");
      await runReplay(values);
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Run 'cua --help' for usage.");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
