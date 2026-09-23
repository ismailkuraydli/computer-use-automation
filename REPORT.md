# Computer-Use Automation System — Design Write-Up

## 1. Architecture

The system is a single-process TypeScript/Node.js application with clean seams that could split into services later. It follows a three-phase lifecycle: **discover → record → replay**, with human-in-the-loop escalation as a cross-cutting concern.

**Key components:**

- **Surface** (interface) — abstracts the target application. `observe()` returns a `ScreenState` (AX tree + DOM snapshot + screenshot). `act()` executes an action. `PlaywrightSurface` implements it for web; a future `DesktopSurface` could implement it for native apps via OS accessibility APIs.
- **AgentLoop** — LLM-driven observe→decide→act loop with step budget, timeout, and dead-end/repeat detection.
- **Recorder** — transforms agent actions into typed `CapabilityArtifact` steps with AX-tree locators, state guards, and checkpoints.
- **ReplayEngine** — deterministic step execution without the LLM. Verifies guards before each step, checkpoints after, handles errors via the three-tier taxonomy.
- **SafetyGuard** — allowlist enforcement + action classification (safe/risky/irreversible).
- **EscalationManager** — CDP-based control transfer with a 5-state control machine.
- **EvidenceCollector** — structured JSON logs, AX snapshots, screenshots with PII redaction.

**Key decisions:**
- **Single process, CLI-driven, JSON file storage** (ADR-007) — the assignment evaluates design, not infrastructure. JSON artifacts are human-readable and git-versionable.
- **Surface interface, not Playwright-specific** (ADR-008) — the artifact schema and replay engine never depend on Playwright directly. This is the seam for extending to desktop.
- **No agent framework** — the agent loop is a simple observe→decide→act cycle. A framework (LangChain, etc.) would obscure the logic the assignment evaluates.

## 2. Artifact Schema

The artifact is the focal point of the system — a typed, versioned, serializable JSON document that serves as a callable capability contract.

**Schema structure:**
```
CapabilityArtifact
├── schemaVersion, artifactVersion
├── capability (name), description
├── surface (type, baseUrl, appVersion)
├── params[] (typed input parameters)
├── outputs[] (typed output declarations)
├── allowlist (permitted domains, URL patterns, actions)
├── steps[] (ordered ArtifactStep list)
│   ├── id, action, target (LocatorSpec)
│   ├── value (may reference {{paramName}})
│   ├── output (for extract actions)
│   ├── guard (pre-execution StateGuard)
│   ├── checkpoint (post-execution StateGuard)
│   └── onError[] (error handlers)
└── checkpoint (final SuccessCondition)
```

**Why this shape:**

- **Hybrid step-list with state guards** (ADR-002) — linear steps are human-readable and reviewable, while guards and checkpoints detect runtime errors before and after each step. A pure step-list is happy-path-only; a full state machine is harder to author and review. The hybrid combines the best of both.
- **AX-tree-first locators** (ADR-003) — `LocatorSpec.primary` uses AX role + accessible name, which is more stable than CSS selectors on legacy surfaces and generalizes to desktop. DOM structural fallback and visual region last resort handle edge cases.
- **Typed params and outputs** — the artifact is a capability contract, not just a step list. An AI agent can discover what inputs it needs and what outputs it returns.
- **Per-step error handlers** — each step declares `onError[]` handlers with conditions (StateGuard) and actions (retry, dismiss, wait, fail, escalate). This is where business outcomes vs. recoverable conditions vs. hard failures are defined.

## 3. Determinism & Error Handling

**Determinism strategy:**
- Replay uses the AX-tree locators recorded during discovery — no LLM in the loop.
- Param substitution replaces `{{paramName}}` with caller-supplied values.
- Guards verify expected state before acting; checkpoints verify expected state after.
- No randomness, no time-based logic, no LLM calls during replay.

**Three-tier error taxonomy** (ADR-004):

1. **Business outcome** — legitimate result the caller needs (member-not-found, validation-error, permission-denied). Returns `{ status: "business-outcome", outcome, detail }`. *Not a crash* — the assignment glossary says conflating these is the most common design mistake.

2. **Recoverable condition** — system can handle and continue (unexpected dialog → dismiss + retry; slow load → wait + retry). Defined per-step in `onError[]` handlers. Returns to normal execution after recovery.

3. **Hard failure** — stop and surface a debuggable error (locator not found, unexpected state, checkpoint failed with no handler). Returns `{ status: "failure", stepId, expected, observed, error }`.

**Error classification flow:**
```
Guard/Checkpoint fails
  → ErrorClassifier.classify(state, step.onError[])
    → First matching handler wins (order matters)
      → handler="fail" + outcome → business outcome
      → handler="retry"/"wait"/"dismiss" → recoverable (attempt recovery)
      → handler="escalate" → escalate to human
      → No match → hard failure
```

**Locator robustness:**
- AX-tree-first (role + accessible name) — stable across minor markup changes
- DOM structural fallback (tag + text + position) — for cases where AX tree is ambiguous
- Visual region (screenshot coordinates) — last resort for non-semantic surfaces
- Frame path support — locators carry `framePath[]` for iframe/frameset traversal

## 4. Heterogeneity & Multi-Tenant

**Surface abstraction (ADR-008):**
The `Surface` interface (`observe()`, `act()`) is the seam between "how we perceive/act on a surface" and "the recorded flow." `PlaywrightSurface` implements it for web. A `DesktopSurface` would implement it using OS accessibility APIs (macOS Accessibility, Windows UI Automation). The artifact schema, replay engine, and error classifier never depend on Playwright — only on the interface.

**Locator strategy generalization:**
AX-tree locators (role + accessible name) work on both web and desktop because both expose accessibility trees. The `LocatorSpec` type is surface-agnostic. Only the `Surface` implementation knows how to resolve a locator to a concrete element.

**Multi-tenant reuse (ADR-009, design-level):**
- **Base artifact** — defines the flow for a vendor product (e.g., "lookup member balance on Fiserv DNA")
- **Tenant overrides** — a patch document that overrides specific steps' locators, URLs, or labels for a specific tenant's configuration
- **Version detection** — each artifact declares the app version it was recorded against; replay checks compatibility and warns on mismatch
- **Canonicalization** — concrete routes normalized to patterns (`/member/12345` → `/member/:id`) so the same artifact works across tenants with different URL structures

**What we built:** The schema supports `surface.appVersion` and `metadata.tenantOverrides` fields. The override resolution is stubbed — the design is there, the plumbing is not, by design (the assignment says "design, not necessarily build").

## 5. Escalation & Handoff

**Control-transfer model** (ADR-006):

The `EscalationManager` uses a 5-state control machine:
```
automation → paused → human → resuming → automation
                         ↓
                       done (terminal — complete or abort)
```

- **Detect & route:** When the ReplayEngine or AgentLoop hits an unrecoverable state (hard failure, irreversible action, stuck), it calls `escalate()`.
- **Pause:** Control state transitions to `paused`. The live browser session (Playwright with `--remote-debugging-port`) exposes a CDP endpoint on localhost.
- **Human takes control:** Operator connects via Chrome to the CDP URL. Control state transitions to `human`. A `HumanActionRecorder` records the operator's actions (clicks, types, navigations).
- **Resume:** Operator signals `done` (manual steps complete), `complete` (goal achieved by human), or `abort`. For `done`, the EscalationManager verifies the current `ScreenState` against the step's checkpoint. If it passes, control returns to `automation` and the run continues. If it fails, the run is declared a failure.

**What's mocked vs. real:**
- **Real:** The control-state machine, CDP endpoint exposure, checkpoint verification on resume, human action recording, evidence across handoff.
- **Mocked:** The operator UI — CLI prints the CDP URL; the operator pastes it into Chrome manually. A full co-browsing console is out of scope per the assignment.

## 6. Safety

**Allowlist enforcement** (ADR-005):
- Each capability artifact declares its own `AllowlistConfig` — permitted domains, URL patterns, and action types.
- `SafetyGuard.check()` runs before every action during both discovery and replay.
- Navigation outside the allowlist is blocked; the agent must re-plan (discovery) or the step fails (replay).

**Action classification:**
- `safe` — read, navigate, type, wait, extract — auto-execute
- `risky` — submit, click-confirm — flagged in evidence but allowed
- `irreversible` — delete, transfer — always blocked and routed to EscalationManager for human approval

**PII redaction:**
- `PIIRedactor` redacts SSNs (`XXX-XX-XXXX`), account numbers (10-12 consecutive digits), and credit card numbers (16 digits) from all evidence and artifacts before writing.
- `ArtifactStore.save()` runs `redactPIIInObject()` on the artifact before serialization.
- `EvidenceCollector.logStep()` redacts all string fields in log entries.
- Artifacts contain parameterized placeholders (`{{memberId}}`), never real member data.

**Limits:**
- The allowlist is per-capability, not per-tenant — a multi-tenant deployment would need tenant-scoped allowlists.
- PII redaction is regex-based — sophisticated data exfiltration patterns (encoded, split across fields) could evade it.
- No rate limiting — the agent could issue actions faster than the target app can handle.

## 7. Cuts

**What we deliberately left out:**

- **Multi-tenant plumbing** — the schema supports it (ADR-009) but we didn't build override resolution, drift detection, or per-tenant artifact storage. The assignment says "design, not necessarily build" for 3.7.
- **Desktop surface** — `PlaywrightSurface` is the only implementation. The `Surface` interface is the seam; a `DesktopSurface` would use OS accessibility APIs. Not built because the assignment says we only need one concrete surface.
- **Real LLM discovery run with evidence** — the `OpenRouterClient` is implemented and tested with mock responses. A real run requires manual execution (`cua discover` without `--mock-llm`). Per ADR-010, no real LLM calls in automated tests.
- **Operator console UI** — CLI prints the CDP URL; operator connects manually. A web-based co-browsing console is out of scope.
- **CI/CD pipeline** — no GitHub Actions. Tests run locally with `npm test`.
- **Docker containerization** — not built. The system runs locally.
- **Rate limiting / backoff** — not implemented. The agent loop has a step budget and timeout but no per-action delay.

**What we'd build next:**
1. **Agent-facing capability catalog** (stretch goal) — expose saved artifacts as callable capabilities with typed args via a function-calling or API surface.
2. **Canonicalization for cross-tenant reuse** (stretch goal) — normalize concrete routes to patterns, demonstrate one artifact working across two app variants.
3. **Assisted fallback** (stretch goal) — bounded, policy-checked LLM recovery for a single failed replay step.
4. **Confidence & approval** (stretch goal) — score artifacts by replay reliability, gate unattended replay on approval state (draft → approved).
5. **Real discovery evidence** — run `cua discover` with a real Claude API key against the mock app, commit the resulting artifact and evidence.
