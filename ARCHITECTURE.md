# Architecture Spec: Computer-Use Automation System

## Requirements

### Functional Requirements

- **Core use cases:**
  1. An AI agent (or developer) issues a natural-language goal against a target application → the system discovers how to accomplish it via an LLM-driven agent loop, records the run as a reusable capability artifact, and makes it available for deterministic replay.
  2. A caller (AI agent or CLI) invokes a saved capability with typed input parameters → the system replays it deterministically (no LLM) and returns typed outputs or a business outcome.
  3. When the system can't safely proceed (discovery stuck, replay unrecoverable error, irreversible action needing approval) → it escalates to a human operator who takes control of the live session, performs manual steps, and hands control back.
- **Inputs:**
  - Discovery: natural-language goal string + target URL/entry point + allowlist configuration
  - Replay: artifact ID + typed input parameters (e.g. `memberId: string`)
- **Outputs:**
  - Discovery: a saved, versioned capability artifact (JSON)
  - Replay: a structured `ReplayResult` — success (with extracted outputs), business outcome (e.g. member-not-found), failure (with debuggable detail), or escalated
  - Both: evidence (structured logs, screenshots, AX/DOM snapshots)
- **Triggers:** CLI commands (discover, replay, escalate). Designed to be callable by an AI agent via a capability interface (stretch goal).
- **Roles:**
  - Developer/Operator: runs discovery, reviews artifacts, handles escalations
  - AI Agent (caller): invokes capabilities by name with typed args (stretch goal)
- **Boundaries:** This system does NOT integrate via APIs (that's the preferred path, out of scope). It does NOT do multi-tenant plumbing, queuing, or clustering (design-only). It does NOT make real LLM calls in tests.

### Non-Functional Requirements

| NFR | Target | Notes |
|---|---|---|
| Scale (tenants) | Hundreds of tenants × ~20 apps | Design-level only — no scaling infrastructure built |
| Latency (replay) | < 5s per step | Replay is deterministic; bounded by page load + action execution |
| Availability | N/A (single process, local) | Design should support service split later |
| Security/Compliance | Regulated financial data | PII redaction, allowlist enforcement, no secrets in artifacts/logs |
| Data consistency | Strong (single-process, file-based) | Artifacts are immutable once saved; versioned |
| Geographic | Single region (local) | Design for multi-region is out of scope |
| Data volume | KB per artifact, MB per evidence run | JSON files; screenshots are the bulk |
| Durability | Artifacts: permanent (git-versioned). Evidence: retained per run. | |

### Constraints
- **Team:** Solo developer (Ismail Kuraydli)
- **Budget:** ~$0 infra (local app, local storage). LLM: ~$0.05–0.20 per discovery run via OpenRouter
- **Timeline:** Time-boxed; focused effort, not a polished product
- **Existing infrastructure:** None (greenfield). TypeScript/Node.js, Playwright, OpenRouter (Claude)
- **Org policies:** Public GitHub repo. No real bank systems. No real credentials/PII. Mock target app only.
- **Compliance constraints:** Redact all PII from artifacts and evidence. No secrets persisted.

## Current State

Greenfield — no existing system.

## Selected Architecture

**Selected:** Option C — Hybrid Step-List with State Guards

**Rationale:** The assignment requires both reviewability (human + agent can understand the capability) and robustness (handles runtime errors, not just happy path). Option C combines the readable linear structure of a step-list with pre-execution guards and post-execution checkpoints that detect runtime errors. The artifact doubles as a communication medium during human escalation — the operator sees which step failed, what was expected, and what was observed.

### Component Breakdown

#### 1. AgentLoop (Discovery Engine)
- **Responsibility:** Takes a goal + target URL, runs an LLM-driven observe→decide→act loop against a live surface until the goal is met or a stopping condition is hit.
- **Inputs:** Goal string, target URL, allowlist config, max steps, timeout
- **Outputs:** A sequence of recorded actions (passed to Recorder), evidence per step
- **Dependencies (upstream):** LLMClient (OpenRouter/Claude), Surface (Playwright), SafetyGuard
- **Dependencies (downstream):** Recorder (receives actions), EvidenceCollector (receives logs/screenshots)
- **Technology:** TypeScript, Anthropic SDK via OpenRouter, Playwright
- **Scaling:** N/A (single run)
- **State:** Stateless per run — holds current step count, goal, conversation history

#### 2. Recorder
- **Responsibility:** Intercepts agent actions during discovery and transforms them into typed artifact steps with locators, guards, checkpoints, and error handlers.
- **Responsibility:** Intercepts agent actions during discovery and transforms them into typed artifact steps with locators, guards, checkpoints, and error handlers.
- **Inputs:** Raw agent actions (action type, target element, value), AX-tree snapshots before/after each action
- **Outputs:** A versioned CapabilityArtifact (JSON)
- **Dependencies (upstream):** AgentLoop (receives actions), Surface (reads AX tree for locator extraction)
- **Dependencies (downstream):** ArtifactStore (saves artifact)
- **Technology:** TypeScript
- **Scaling:** N/A
- **State:** Accumulates steps during a discovery run

#### 3. ArtifactStore
- **Responsibility:** Serializes, loads, and versions capability artifacts.
- **Inputs:** CapabilityArtifact (save), artifact ID + version (load)
- **Outputs:** JSON file on disk, or loaded artifact object
- **Dependencies (upstream):** Recorder (saves), ReplayEngine (loads)
- **Dependencies (downstream):** Filesystem
- **Technology:** Node.js fs, JSON
- **Scaling:** N/A (file-based)
- **State:** Stateless (reads/writes files)

#### 4. ReplayEngine
- **Responsibility:** Loads an artifact + params, executes steps deterministically (no LLM), verifies guards and checkpoints, handles errors, returns structured result.
- **Inputs:** Artifact ID, input parameters
- **Outputs:** ReplayResult (success + outputs | business-outcome | failure | escalated)
- **Dependencies (upstream):** ArtifactStore (loads artifact), Surface (executes actions), ErrorClassifier (classifies failures), SafetyGuard (enforces allowlist), EscalationManager (escalates)
- **Dependencies (downstream):** EvidenceCollector (receives logs/screenshots)
- **Technology:** TypeScript
- **Scaling:** N/A
- **State:** Holds current step index, accumulated outputs, run state

#### 5. Surface (Interface + PlaywrightSurface implementation)
- **Responsibility:** Abstracts the target application surface. Provides `observe() → ScreenState` (AX tree + DOM snapshot) and `act(Action) → ActionResult`. PlaywrightSurface implements this for web browsers.
- **Inputs:** Actions (navigate, click, type, extract, wait), locator specs
- **Outputs:** ScreenState (AX tree, DOM snapshot, URL, screenshot), ActionResult (success/failure with detail)
- **Dependencies (upstream):** AgentLoop, ReplayEngine (call observe/act)
- **Dependencies (downstream):** Playwright browser (Chromium)
- **Technology:** Playwright, TypeScript interface, CDP (Chrome DevTools Protocol) for AX tree
- **Scaling:** Single browser session
- **State:** Holds the live browser session (Playwright Page/BrowserContext)
- **AX tree strategy (ADR-011):** observe() uses CDP `Accessibility.getFullAXTree` for the main frame (the browser's real accessibility tree — handles all element types, ARIA attributes, shadow DOM, computed names automatically). Falls back to the JS-based AX tree builder for iframe content (CDP doesn't traverse frames). act() uses Playwright's native `getByRole()` (which also uses the browser's real AX tree) with `getByText()` as a last-resort fallback for elements that getByRole misses (labels, spans, custom widgets).

#### 6. LocatorStrategy
- **Responsibility:** Given a target spec (AX role + name, or DOM selector, or visual region), resolves to a concrete element on the current page. Handles frameset/iframe traversal.
- **Inputs:** Locator spec from artifact step
- **Outputs:** Resolved element handle (or failure if not found)
- **Dependencies (upstream):** Surface (reads page state), ReplayEngine (requests resolution)
- **Dependencies (downstream):** Playwright element API
- **Technology:** Playwright AX-tree API, DOM query API
- **Scaling:** N/A
- **State:** Stateless

#### 7. ErrorClassifier
- **Responsibility:** Examines the current page state after a step and classifies the result: business outcome (member-not-found, validation-error), recoverable condition (dialog, slow-load), or hard failure (locator-not-found, unexpected-state).
- **Inputs:** Current ScreenState, artifact step's error handler definitions
- **Outputs:** ErrorClassification (tier + specific error + recommended action)
- **Dependencies (upstream):** ReplayEngine (requests classification), Surface (reads state)
- **Dependencies (downstream):** ReplayEngine (decides next action)
- **Technology:** TypeScript, pattern matching against AX-tree/DOM signatures
- **Scaling:** N/A
- **State:** Stateless

#### 8. SafetyGuard
- **Responsibility:** Enforces allowlist (permitted URLs/domains + action types), classifies actions (safe/risky/irreversible), and redacts PII from artifacts and evidence.
- **Inputs:** Action + target URL, allowlist config, evidence/artifact content
- **Outputs:** Allow/deny decision, action classification, redacted content
- **Dependencies (upstream):** AgentLoop (checks before acting), ReplayEngine (checks before executing), Recorder/EvidenceCollector (redacts before writing)
- **Dependencies (downstream):** EscalationManager (routes irreversible actions)
- **Technology:** TypeScript, regex-based PII redaction patterns
- **Scaling:** N/A
- **State:** Stateless (allowlist loaded per capability)

#### 9. EscalationManager
- **Responsibility:** Detects stuck/blocked states, pauses automation, exposes the live session for human control, records human actions, and resumes or completes the run.
- **Inputs:** Escalation trigger (stuck state, hard failure, irreversible action), current ScreenState, artifact context
- **Outputs:** EscalationRequest (with context), control-state transitions, human-action log
- **Dependencies (upstream):** AgentLoop (escalation from discovery), ReplayEngine (escalation from replay), SafetyGuard (irreversible action routing)
- **Dependencies (downstream):** Surface (exposes live session), EvidenceCollector (records human actions)
- **Technology:** CDP endpoint exposure, control-state machine, Playwright action listener
- **Scaling:** N/A
- **State:** Control state (`automation | paused | human | resuming`), session reference, human action log

#### 10. EvidenceCollector
- **Responsibility:** Collects and stores structured logs, screenshots, AX-tree snapshots, and DOM snapshots for each run (discovery and replay).
- **Inputs:** Log entries, screenshots, AX/DOM snapshots from AgentLoop/ReplayEngine
- **Outputs:** Evidence directory per run (`/evidence/{run-id}/`)
- **Dependencies (upstream):** AgentLoop, ReplayEngine, EscalationManager, SafetyGuard (all send evidence)
- **Dependencies (downstream):** Filesystem
- **Technology:** Node.js fs, Playwright screenshots, JSON logging
- **Scaling:** N/A
- **State:** Accumulates evidence per run

### Interface Contracts

#### Artifact Schema (CapabilityArtifact)

The artifact is the central contract. It is a typed, versioned, serializable JSON document.

```typescript
interface CapabilityArtifact {
  schemaVersion: string;           // "1.0"
  artifactVersion: number;         // increments on edits
  capability: string;              // "lookup-member-balance"
  description: string;             // human-readable summary
  surface: {
    type: "web" | "desktop";       // surface type for abstraction
    baseUrl: string;               // canonical entry point
    appVersion?: string;           // vendor app version (for drift detection)
  };
  params: ParamSpec[];             // typed input parameters
  outputs: OutputSpec[];           // typed output declarations
  allowlist: AllowlistConfig;      // permitted URLs + action types
  steps: ArtifactStep[];          // ordered steps
  checkpoint: SuccessCondition;    // final success condition
  metadata: {
    recordedAt: string;            // ISO timestamp
    recordedBy: string;            // operator/dev name
    tenantOverrides?: string;      // path to override file (design-level)
  };
}

interface ParamSpec {
  name: string;                    // "memberId"
  type: "string" | "number" | "boolean";
  required: boolean;
  description?: string;
  redact?: boolean;                // if true, value is PII — never logged
}

interface OutputSpec {
  name: string;                    // "savingsBalance"
  type: "string" | "number" | "object";
  description?: string;
}

interface AllowlistConfig {
  permittedDomains: string[];      // ["localhost", "keystone-internal.local"]
  permittedUrlPatterns: string[];  // ["/members*", "/accounts/*"]
  permittedActions: ActionType[];  // ["navigate", "click", "type", "extract", "wait"]
  riskyActions?: ActionType[];     // ["submit"] — flagged in evidence
  irreversibleActions?: ActionType[]; // ["delete", "transfer"] — always escalate
}

interface ArtifactStep {
  id: number;
  action: ActionType;              // "navigate" | "click" | "type" | "extract" | "wait" | "submit"
  target: LocatorSpec;             // how to find the element
  value?: string;                  // for type actions — may reference params: "{{memberId}}"
  output?: string;                 // for extract actions — maps to an OutputSpec name
  guard?: StateGuard;              // pre-execution: what the screen must look like
  checkpoint?: StateGuard;         // post-execution: what the screen must look like
  onError?: ErrorHandler[];         // error handlers for this step
  classification?: "safe" | "risky" | "irreversible";
}

type ActionType = "navigate" | "click" | "type" | "extract" | "wait" | "submit";

interface LocatorSpec {
  primary: AXLocator;              // AX-tree-first
  fallback?: DOMLocator;           // DOM structural fallback
  visual?: VisualLocator;          // screenshot region (last resort)
  framePath?: string[];            // path through frameset/iframe tree
}

interface AXLocator {
  role: string;                    // "textbox", "button", "cell", "link"
  name: string;                    // accessible name
  description?: string;            // accessible description (if name is ambiguous)
}

interface DOMLocator {
  selector: string;                // CSS selector (structural, not ID-based)
  text?: string;                   // text content for disambiguation
  position?: { index: number };    // nth match if multiple
}

interface VisualLocator {
  region: { x: number; y: number; w: number; h: number };
  description: string;            // "the 'Search' button in the top-right toolbar"
}

interface StateGuard {
  anyOf?: ScreenSignature[];       // any of these signatures satisfies the guard
  allOf?: ScreenSignature[];       // all must be present
  expect?: "loaded" | "unloaded";  // page-level state
}

interface ScreenSignature {
  axContains?: AXLocator[];        // AX tree must contain these elements
  urlPattern?: string;             // URL must match this pattern
  textContains?: string;           // page text must contain this string
}

interface ErrorHandler {
  when: StateGuard;                // condition that triggers this handler
  handler: "retry" | "dismiss" | "wait" | "fail" | "escalate";
  maxRetries?: number;
  outcome?: string;                // business outcome name (for "fail" with business outcome)
  description?: string;
}

interface SuccessCondition {
  axContains?: AXLocator[];
  urlPattern?: string;
  outputsExtracted?: boolean;      // all declared outputs were extracted
}
```

#### ReplayResult Contract

```typescript
type ReplayResult =
  | { status: "success"; outputs: Record<string, string | number | object>; evidencePath: string }
  | { status: "business-outcome"; outcome: string; detail: string; evidencePath: string }
  | { status: "failure"; stepId: number; expected: string; observed: string; error: string; evidencePath: string }
  | { status: "escalated"; stepId: number; reason: string; humanActions: HumanAction[]; evidencePath: string }
  | { status: "escalated"; stepId: number; reason: string; evidencePath: string };

interface HumanAction {
  action: ActionType;
  target: string;                   // human-readable description
  timestamp: string;
  result: "success" | "failure";
}
```

#### Discovery CLI Contract

```
$ cua discover --goal "Look up member 12345 and read their savings balance" \
               --target "http://localhost:3000" \
               --allowlist ./allowlist.json \
               --output ./artifacts/lookup-member-balance.json

→ Runs AgentLoop → Recorder → saves artifact → prints artifact path
```

#### Replay CLI Contract

```
$ cua replay --artifact ./artifacts/lookup-member-balance.json \
             --params '{"memberId": "12345"}' \
             --target "http://localhost:3000"

→ Runs ReplayEngine → prints ReplayResult → saves evidence to /evidence/{run-id}/
```

#### Escalation Contract

```
$ cua escalate --session <session-id>
→ Exposes CDP endpoint for operator to connect
→ Operator controls live session via Chrome
→ Operator signals done/complete/abort
→ EscalationManager records human actions → resumes or completes
```

### Data Flow

#### Discovery Path (Write)
```
Goal + Target → AgentLoop
  → Surface.observe() → ScreenState (AX tree + DOM + screenshot)
  → LLMClient.decide(ScreenState, goal, history) → Action
  → SafetyGuard.check(action, url) → allow/deny
  → Surface.act(action) → ActionResult
  → Recorder.capture(action, beforeState, afterState) → Step added to artifact
  → EvidenceCollector.log(step, screenshot, AX snapshot)
  → repeat until goal met or stopping condition
  → Recorder.finalize() → CapabilityArtifact
  → ArtifactStore.save(artifact) → /artifacts/{capability}/v{n}.json
```

#### Replay Path (Read)
```
Artifact ID + Params → ReplayEngine
  → ArtifactStore.load(artifactId) → CapabilityArtifact
  → SafetyGuard.checkAllowlist(artifact.allowlist) → verify scope
  → for each step in artifact.steps:
      → Surface.observe() → ScreenState
      → LocatorStrategy.resolve(step.target, ScreenState) → element
      → check guard: StateGuard matches ScreenState? 
         → if fail: ErrorClassifier.classify(step.onError, ScreenState)
           → match handler: retry / dismiss / wait / fail / escalate
           → if no match: EscalationManager.escalate()
      → Surface.act(step.action, element, step.value) → ActionResult
      → check checkpoint: StateGuard matches new ScreenState?
         → if fail: ErrorClassifier.classify → handle or escalate
      → if step.action == "extract": store output
      → EvidenceCollector.log(step, screenshot, AX snapshot)
  → verify final checkpoint (SuccessCondition)
  → return ReplayResult
```

#### Escalation Path
```
Trigger (stuck/hard-failure/irreversible) → EscalationManager
  → set control state: automation → paused
  → Surface.exposeCDP() → CDP endpoint URL
  → EscalationRequest sent (with: capability, step, ScreenState, reason)
  → Operator connects via Chrome to CDP endpoint
  → set control state: paused → human
  → Playwright listener records human actions (clicks, types, navigations)
  → Operator signals: done | complete | abort
  → set control state: human → resuming
  → EscalationManager verifies current ScreenState against step checkpoint
  → if checkpoint passes: resume from current step → control state: automation
  → if operator signaled complete: return ReplayResult with human actions
  → if abort: return failure with context
  → EvidenceCollector.log(escalation, human actions, before/after states)
```

#### Cache Strategy
No caching. Artifacts are loaded from disk per replay run. Evidence is write-once.

#### Async Paths
No async/queue paths. All operations are synchronous within a single CLI invocation. The design supports adding a queue (replay jobs submitted → processed asynchronously) but we don't build it.

### Failure Mode Analysis

| Component | Failure | Blast Radius | Recovery | Silent/Noisy |
|---|---|---|---|---|
| AgentLoop | LLM returns invalid/unparseable action | Discovery stops | Retry with corrected prompt; after N retries, escalate | Noisy (logged) |
| AgentLoop | Max steps exceeded | Discovery stops | Escalate to human | Noisy |
| AgentLoop | LLM API timeout/error | Discovery stops | Retry with backoff; after N, escalate | Noisy |
| Surface | Playwright browser crash | Run dies | Restart browser, re-run from beginning (no mid-run resume for discovery) | Noisy |
| Surface | Page navigation timeout | Step fails | Retry step; after N, escalate | Noisy |
| LocatorStrategy | AX locator not found | Step fails | Try DOM fallback, then visual fallback; if all fail, escalate | Noisy (logged with screenshots) |
| LocatorStrategy | Multiple elements match AX locator | Ambiguous action | Use DOM fallback position to disambiguate; if still ambiguous, escalate | Noisy |
| ReplayEngine | Guard check fails before step | Step can't execute | Run error handlers; if no match, escalate | Noisy |
| ReplayEngine | Checkpoint fails after step | Step may not have worked | ErrorClassifier examines state; match against onError handlers; if no match, hard failure | Noisy |
| ErrorClassifier | State doesn't match any known error pattern | Unclassifiable failure | Default to hard failure → escalate | Noisy (logged with full state) |
| EscalationManager | CDP endpoint unreachable | Human can't connect | Retry exposure; if fails, abort run with context | Noisy |
| EscalationManager | Operator doesn't respond | Run stays paused indefinitely | Timeout (configurable) → abort run | Noisy (timeout alert) |
| SafetyGuard | Action outside allowlist | Action blocked | Log violation; if during discovery, agent re-plans; if during replay, hard failure | Noisy |
| ArtifactStore | Artifact file corrupted/missing | Can't replay | Clear error: "artifact not found" or "artifact corrupted" | Noisy |

**SPOFs:** The Playwright browser session — single instance per run. If it dies, the run dies. Acceptable for single-process scope.

**Cascading failure risks:** None significant — single process, no inter-service dependencies.

**Data loss scenarios:** Evidence is written incrementally (per step), so a crash mid-run preserves partial evidence. Artifacts are written atomically (temp file → rename) to prevent corruption on crash.

**Silent failure paths:** The primary risk is a checkpoint that passes but the extracted output is wrong (e.g., wrong table cell read). Mitigation: output extraction includes the source locator + a description in evidence, so a human reviewer can verify what was actually read.

### Deployment Topology

- **Environments:** Single local environment. No staging/prod split for the project. Design supports running in a container (Dockerfile in repo) but we don't build CI/CD.
- **Scaling:** Single process. No auto-scaling. Design has clean seams for future service split (discovery service, replay service, artifact registry, operator console).
- **Regions:** N/A (local).
- **Network:** Local only. Mock app on `localhost:3000`. CDP endpoint on `localhost` only (never exposed to network).
- **CI/CD:** GitHub repo. No CI pipeline required (tests are local, no LLM calls in tests). Optional: GitHub Actions running `npm test`.
- **Observability:** Structured JSON logs per run in `/evidence/{run-id}/`. Per-step: timestamp, action, target, guard result, checkpoint result, screenshot path, AX snapshot path. Aggregated run summary at end.

### Migration Path

N/A — greenfield.

## Architecture Decision Records

See [DECISIONS.md](./DECISIONS.md) for the full ADR log. Summary:

- ADR-001: TypeScript + Node.js + Playwright
- ADR-002: Hybrid Step-List with State Guards (Option C)
- ADR-003: AX-Tree-First Locator Strategy with DOM Fallback
- ADR-004: Three-Tier Error Taxonomy
- ADR-005: Allowlist + Action Classification Safety Model
- ADR-006: Live-Session Control Transfer via CDP
- ADR-007: Single Process, CLI-Driven, JSON File Storage
- ADR-008: Surface Abstraction via Observe/Act Interface
- ADR-009: Multi-Tenant Reuse via Base Artifact + Per-Tenant Overrides
- ADR-010: LLM Isolation — Mock in Tests, Real Only for Manual Discovery
- ADR-011: CDP AX Tree for observe(), Playwright getByRole/getByText for act()
- ADR-012: Sub-goals and goal-aware AX prioritization
- ADR-013: Output verification + new action types (scroll, read_page_text)

## Open Questions

- [x] OQ-1: ~~Does Playwright's `page.accessibility.snapshot()` traverse framesets/iframes correctly?~~ RESOLVED: page.accessibility.snapshot() was removed in Playwright 1.63. Replaced with CDP Accessibility.getFullAXTree for main frame (ADR-011) + JS builder fallback for iframes. Spike confirmed locator stability on hostile surface.
- [ ] OQ-2: Will the mock app need session-based auth to exercise the session-timeout error path, or should we simulate it with a configurable timeout flag?
- [ ] OQ-3: Should the operator UI be a minimal web page (CDP viewer) or just a CLI that prints the CDP URL for the operator to paste into Chrome? Lean toward CLI — simpler, real mechanism.
- [ ] OQ-4: Do we implement the agent-facing capability catalog (stretch goal) or leave it as a documented seam? Depends on time remaining after the core vertical slice.

## Implementation Plan

### Phase 1: Foundation
- [ ] Surface interface + PlaywrightSurface implementation (observe/act via AX tree + DOM)
- [ ] Mock app: "Keystone Credit Union — Member Servicing Portal" (hostile surface)
- [ ] LocatorStrategy: AX-first with DOM fallback + frame traversal
- [ ] Spike: validate AX-tree locator stability on the mock app

### Phase 2: Discovery
- [ ] LLMClient interface + OpenRouterClient (Claude) + MockLLMClient
- [ ] AgentLoop: observe → decide → act with step budget, timeout, dead-end detection
- [ ] Recorder: transform agent actions into artifact steps with locators/guards/checkpoints
- [ ] SafetyGuard: allowlist enforcement + PII redaction
- [ ] EvidenceCollector: structured logs, screenshots, AX snapshots

### Phase 3: Replay
- [ ] ArtifactStore: save/load/version artifacts
- [ ] ReplayEngine: execute steps, verify guards/checkpoints
- [ ] ErrorClassifier: three-tier error taxonomy
- [ ] ReplayResult contract: success/business-outcome/failure/escalated

### Phase 4: Escalation
- [ ] EscalationManager: pause, expose CDP, control-state machine, resume
- [ ] Human action recording via Playwright listener
- [ ] EscalationRequest contract with context

### Phase 5: Integration & Evidence
- [ ] CLI: `cua discover`, `cua replay`, `cua escalate`
- [ ] End-to-end evidence: one discovery run + one replay run + one error/escalation
- [ ] REPORT.md: seven required headings
- [ ] README.md: setup, demo path, how to run without live services

### Phase 6: Stretch (if time permits)
- [ ] Agent-facing capability catalog (callable by name with typed args)
- [ ] Canonicalization for cross-tenant reuse
- [ ] Multi-run stability signal

---
*Spec by architecture-spec skill — 2026-09-23*
