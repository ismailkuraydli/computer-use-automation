# Computer-Use Automation System

A backend integration layer that lets AI agents operate legacy bank/credit-union applications with no API. The system uses an LLM to discover how to accomplish a goal the first time, records the run as a reusable **capability artifact**, and replays it **deterministically** (no LLM) in production.

**The model discovers. The artifact becomes a reusable capability. Deterministic replay is how the AI agent invokes it in production.**

## Setup

```bash
# Clone and install
git clone https://github.com/ismailkuraydli/computer-use-automation.git
cd computer-use-automation
npm install
npx playwright install chromium

# Build (optional — tsx runs TypeScript directly)
npm run build
```

## Running without live services

All automated tests use `MockLLMClient` and `MockSurface` — **zero API calls, zero browser required**:

```bash
npm test
```

For integration tests that need the mock app:

```bash
# Terminal 1: start the mock app
npm run mock-app

# Terminal 2: run tests
npm test
```

## Demo path

The demo uses a hostile mock app ("Keystone Credit Union Member Servicing Portal") with iframes, table layouts, no test IDs, and non-semantic markup.

### Step 1: Start the mock app

```bash
npm run mock-app
# → Keystone CU mock app running on http://localhost:3000
```

### Step 2: Run a discovery (with mock LLM)

```bash
npm run discover -- --goal "Look up member 12345 and read their savings balance" \
                    --target http://localhost:3000 \
                    --mock-llm \
                    --output ./artifacts
```

This runs the agent loop with scripted LLM responses (no real API calls), records the flow as a `CapabilityArtifact`, and saves it to `./artifacts/lookup-member-balance/v1.json`.

### Step 2b: Run a discovery (with real LLM)

```bash
export OPENROUTER_API_KEY=your-key
npm run discover -- --goal "Look up member 12345 and read their savings balance" \
                    --target http://localhost:3000 \
                    --output ./artifacts
```

This uses Claude via OpenRouter for real LLM-driven discovery (~$0.05-0.20 per run).

### Step 3: Replay the artifact

```bash
npm run replay -- --artifact ./artifacts/lookup-member-balance/v1.json \
                  --params '{"memberId":"12345"}' \
                  --target http://localhost:3000
```

This replays the artifact deterministically (no LLM) and prints a structured `ReplayResult`.

### Step 4: Replay with error state (business outcome)

```bash
npm run replay -- --artifact ./artifacts/lookup-member-balance/v1.json \
                  --params '{"memberId":"99999"}' \
                  --target http://localhost:3000
```

This should return `business-outcome` with `outcome: "member-not-found"` — a legitimate result, not a crash.

### Step 5: Review evidence

Evidence from each run is saved to `./evidence/{run-id}/`:
- `structured-log.json` — step-by-step log of what happened
- `step-N-ax.json` — AX tree snapshot per step
- `run-summary.json` — run outcome and outputs

## CLI reference

```
cua discover  --goal "..." --target URL [--mock-llm] [--output path] [--allowlist file]
cua replay    --artifact path --params JSON --target URL
cua escalate  (exposes CDP endpoint for operator to connect)
```

## Architecture

See [REPORT.md](./REPORT.md) for the full design write-up with seven sections:
1. Architecture
2. Artifact schema
3. Determinism & error handling
4. Heterogeneity & multi-tenant
5. Escalation & handoff
6. Safety
7. Cuts

## Tech stack

- **TypeScript** + Node.js — typed contracts for the artifact schema and replay result
- **Playwright** — browser automation with AX-tree access and iframe traversal
- **Vitest** — test runner with TDD red-green-refactor
- **Express** — mock app server
- **OpenRouter** (Claude) — LLM for discovery runs (manual only, not in tests)

## Design decisions

See [DECISIONS.md](./DECISIONS.md) for 10 ADRs covering every major design choice.

## Testing

```bash
npm test          # all tests (unit + integration with mock app running)
npm run typecheck # TypeScript compilation check
```

**102 tests** covering: PII redaction, locator strategy, PlaywrightSurface, locator spike, SafetyGuard, EvidenceCollector, ArtifactStore, Recorder, AgentLoop, GuardChecker, ErrorClassifier, ReplayEngine, ControlState, HumanActionRecorder, EscalationManager.

Zero real API calls in tests — `MockLLMClient` provides scripted responses (ADR-010).
