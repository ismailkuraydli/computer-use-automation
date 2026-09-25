# Computer-Use Automation System

A backend integration layer that lets AI agents operate legacy bank and credit-union applications that have no API. An LLM works out how to reach a goal the first time; the run is recorded as a typed, versioned **capability artifact**; the artifact is then replayed **deterministically, without the LLM**, as the production path. When replay meets something it cannot handle safely, a human takes over the same live session and hands control back.

> **The model discovers. The artifact becomes a reusable capability. Deterministic replay is how the AI agent invokes it in production.**

Design write-up: [REPORT.md](./REPORT.md). Decision log: [DECISIONS.md](./DECISIONS.md). Evidence: [evidence/demo](./evidence/demo/README.md).

## Setup

```bash
git clone https://github.com/ismailkuraydli/computer-use-automation.git
cd computer-use-automation
npm install
npx playwright install chromium
```

Real LLM discovery needs an OpenRouter key in `.env` (the model is set in `cua.config.json`):

```bash
echo "OPENROUTER_API_KEY=sk-or-..." > .env
```

## Running without live services

```bash
npm test                 # everything: unit tests + Playwright tests against an in-process mock app
npm run test:scenarios   # just the replay acceptance matrix (19 scenarios: runtime conditions + cross-tenant)
npm run typecheck
```

No API key, no running server needed: tests start their own mock app on a random port and use scripted LLM responses.

## Demo path

The target is **Keystone CU**, a deliberately hostile stand-in for a legacy back office (iframes, table layouts, no test IDs, non-semantic markup). It can inject the runtime conditions the brief describes: blocking notices, slow loads, transient 503s, session expiry, native confirm dialogs. "Not found", validation errors and permission denials are always on.

```bash
# Terminal 1
npm run mock-app                                  # http://localhost:3000
```

**1. Discover** (real LLM) a capability from a goal:

```bash
npm run discover -- --goal "Look up member 23456 and read the balance of their Savings account" \
  --target http://localhost:3000/search --app keystone-cu --allowlist allowlists/keystone-cu.json
```

This plans params/outputs, drives the app, records the artifact to `artifacts/<capability>/vN.json`, then **replays it once as a self-check** (result in `metadata.selfCheck`).

**2. Replay** it deterministically with other inputs:

```bash
A=artifacts/lookup-member-savings-balance/v1.json
npm run replay -- --artifact $A --params '{"memberId":"45678"}'   # success → Savings balance "$45,200.00"
npm run replay -- --artifact $A --params '{"memberId":"99999"}'   # business-outcome: not-found
```

**3. Inject a runtime condition** and replay again:

```bash
curl -X POST localhost:3000/__faults -H 'content-type: application/json' -d '{"interstitialPaths":["/search"]}'
npm run replay -- --artifact $A --params '{"memberId":"12345"}'   # known notice → dismissed, success
curl -X POST localhost:3000/__faults -H 'content-type: application/json' -d '{"expireSessionAfter":2}'
npm run replay -- --artifact $A --params '{"memberId":"12345"}'   # session expired → escalated
curl -X DELETE localhost:3000/__faults
```

**4. Hand the live session to a human** on escalation. This opens a visible browser; automation pauses and prints an intervention request:

```bash
curl -X POST localhost:3000/__faults -H 'content-type: application/json' -d '{"expireSessionAfter":0}'
npm run replay -- --artifact $A --params '{"memberId":"12345"}' --handoff
# The session is expired when the run starts, so step 1 escalates.
# While paused, "log in again": in another terminal run  curl -X DELETE localhost:3000/__faults
# then type `done` → step 1 is re-checked, re-run, and the replay completes.
# (`complete` = you finished the task yourself, `abort` = stop.)
```

**5. Irreversible actions** need explicit confirmation from the caller:

```bash
npx tsx scripts/export-fixture-artifacts.ts ./artifacts/fixtures
F=artifacts/fixtures/open-sub-account/v1.json
P='{"memberId":"12345","accountType":"Checking","deposit":"250"}'
npm run replay -- --artifact $F --params "$P"             # escalated: irreversible step not confirmed
npm run replay -- --artifact $F --params "$P" --confirm   # success → {"accountNumber": ...}
```

**6. Reuse the artifact at another institution** running the same product. Summit FCU relabels fields ("Account Holder #"), moves member pages to `/members/:id` and adds its own security reminder; the Keystone artifact runs there through a small overlay (`profiles/tenants/keystone-cu/summit.json`), without re-recording:

```bash
npm run mock-app:summit                                              # second tenant on :3100
npm run replay -- --artifact $A --params '{"memberId":"23456"}' --tenant summit
```

Every run writes `evidence/<run-id>/`: `structured-log.json`, per-step accessibility snapshots, masked screenshots, and for discovery the (redacted) LLM conversation. The curated set in [`evidence/demo`](./evidence/demo/README.md) is regenerated by `scripts/generate-evidence.sh`.

## Use it from Claude Code or Codex (plugin)

The repo is a plugin for both hosts. It runs an MCP server (`bin/cua-mcp`) with three tools, plus a skill that tells the agent how to use them:

| Tool | What it does |
|---|---|
| `list_capabilities` | Saved capabilities with JSON-Schema params, outputs, version, and whether they have irreversible steps |
| `run_capability` | `{name, params, version?, tenant?, confirmIrreversible?}` → deterministic replay, returns the ReplayResult |
| `discover_capability` | `{goal, target?, app?, allowlist?}` → LLM discovery, self-check, saves a new capability |

**Claude Code**

```bash
claude plugin marketplace add ismailkuraydli/computer-use-automation
claude plugin install computer-use-automation@computer-use-automation
```

On install Claude asks for two settings: the **application URL** (`target_url`, where the app you automate runs, e.g. `https://core.bank.example` or `https://bank.example/portal`) and the OpenRouter key (used only by `discover_capability`). Capabilities replay against the configured URL whatever URL they were recorded on, and discovery starts there (`target` can then be omitted or be a path like `/search`). Leave it empty to use each capability's recorded URL.

**Codex**

```bash
codex plugin marketplace add ismailkuraydli/computer-use-automation
codex plugin add computer-use-automation@computer-use-automation
```

Codex passes `CUA_TARGET_URL` (the application URL), `OPENROUTER_API_KEY` and `CUA_WORKSPACE` through from your environment.

The first start installs dependencies and Chromium (a minute or two). Artifacts and evidence go to `CUA_WORKSPACE`: in Claude Code the default is the project you are working in; under Codex (which starts the server in the plugin directory) it is `~/.computer-use-automation`. Profiles and allowlists are read from the workspace first, then from the ones shipped with the plugin. Without installing a plugin, any MCP host can run it directly: `claude mcp add cua -- /path/to/repo/bin/cua-mcp`.

## CLI reference

```
cua discover --goal "..." --target URL [--app PROFILE] [--allowlist FILE] [--mock-llm] [--headed]
cua replay   --artifact FILE --params JSON [--base-url URL] [--tenant NAME] [--target URL] [--confirm] [--handoff] [--headed]
npm run mcp  # the MCP server on stdio (what the plugins start)
npm run ui   # local web UI: discovery, artifacts, replay, evidence (http://localhost:3001)
```

| Path | What it is |
|---|---|
| `profiles/<app>.json` | App profile: interstitials to dismiss, runtime conditions → business outcome / retry / escalate / hard failure |
| `profiles/tenants/<app>/<tenant>.json` | Tenant overlay: host, relabelled UI text, route rewrites, extra interstitials and sensitive fields |
| `allowlists/<app>.json` | Domains, URL patterns, action types, irreversible actions |
| `artifacts/<capability>/vN.json` | Recorded capabilities (schema v2; v1 files are migrated on load) |
| `mock-app/` | Keystone CU mock app (and the Summit FCU variant) with fault injection (`POST/DELETE /__faults`) |
| `.claude-plugin/`, `.codex-plugin/`, `.agents/plugins/`, `codex-mcp.json`, `skills/` | Plugin manifests, marketplaces and the agent skill |
| `src/scenarios/` | Scenario matrix: the replay acceptance gate |

## Tech stack

TypeScript on Node.js · Playwright (Chromium, accessibility tree, frames) · Vitest · Express (mock app, UI) · OpenRouter for the discovery model.

## Limitations

- **Public consumer sites** use bot detection, CAPTCHAs and marketing overlays. The system does not try to get around them. An unknown overlay or dialog escalates to a human (`--handoff`), and the fix can become a profile entry.
- **Redaction depends on the app profile.** SSNs and account/card numbers are caught by pattern. Names, dates of birth and other fields are caught once the profile marks where they appear (`sensitive` in `profiles/<app>.json`). See REPORT §6.
- **One browser session per run.** It runs as a single local process, with no queueing or session pooling.
- **No handoff over MCP.** An escalation reaches the calling agent as `status: "escalated"`; the live-session handoff is CLI-only (`--handoff`).
