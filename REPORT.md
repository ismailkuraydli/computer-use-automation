# Computer-Use Automation System — Design Write-Up

The model discovers once; the recorder turns the successful run into a typed capability artifact; deterministic replay is how an agent invokes it. The one rule that shapes everything below: **site knowledge lives in data (the artifact and the app profile), never in engine code.** When replay meets something it does not recognize, a human takes over the live session. Their fix can then be added to the profile as data.

## 1. Architecture

A single TypeScript process with a CLI (and a small local web UI). The seams are interfaces, not services:

| Component | Responsibility |
|---|---|
| `Surface` (`PlaywrightSurface`) | `observe()` → accessibility snapshot + screenshot; `act()` → one action on a semantic target; human-action capture. The only Playwright code. |
| `playwright-resolver` | The single place a target becomes an element. Strict: ambiguous = error. |
| `AgentLoop` + `OpenRouterClient` | LLM observe → decide → act loop (step budget, timeout, dead-end detection, sub-goals). |
| `Recorder` (+ `step-builders`, `parameterize`) | Successful actions → schema-v2 steps, targets, checkpoints, `{{param}}` templates. |
| `ReplayEngine` | Deterministic replay: policy, act, checkpoint, recover, escalate. No LLM. |
| App profile (`profiles/*.json`) | Interstitials and runtime conditions shared by every artifact of one app. |
| `EscalationManager` + `OperatorChannel` | Control-transfer state machine and live-session handoff. |
| `CapabilityCatalog` + MCP server (`src/mcp`) | Agent-facing tools over saved artifacts; shipped as a Claude Code and Codex plugin. |
| `replay-service`, `discovery-service` (`src/app`) | One replay / one discovery, shared by the CLI and the MCP server. |
| `SafetyGuard`, `pii-redactor`, `EvidenceCollector` | Allowlist, action classes, redaction, structured evidence. |

**Decisions and trade-offs.**
- **Accessibility tree first.** It is what an operator perceives, it exists on desktop platforms too, and it survives markup churn better than DOM paths.
- **One process, JSON on disk.** The brief rewards design, not infrastructure. Artifacts and profiles are reviewable in a pull request.
- **No agent framework.** The loop is short and the evaluated logic stays visible.
- **The target is a local, deliberately hostile back-office app**, not a public site (ADR-014). Public consumer sites fail through A/B layouts, marketing modals and bot detection. The brief's environment fails through runtime conditions, and the mock app injects exactly those. `src/scenarios/scenario-matrix.test.ts` (19 rows) is the acceptance gate for the replay engine.

## 2. Artifact schema

```
CapabilityArtifact (schemaVersion "2.0")
├── capability, description, artifactVersion
├── surface { type, baseUrl, app → profiles/<app>.json, appVersion }
├── params[]  { name, type, required, redact }        ← agent-supplied inputs
├── outputs[] { name, type }                          ← what the agent gets back
├── allowlist { domains, urlPatterns, actions, risky/irreversible action types }
├── steps[]
│   ├── action: navigate | click | type | select | extract | submit | wait | scroll
│   ├── target { role, name?, row?, column?, label?, frame? }   (may contain {{param}})
│   ├── value (may contain {{param}}), output
│   ├── checkpoint { anyOf/allOf: [{ urlPattern, textContains, axContains[] }] }
│   ├── onError[] { when, kind: business-outcome | retry | escalate | hard-failure, outcome }
│   └── classification: safe | risky | irreversible
├── checkpoint { ..., outputsExtracted }              ← final success condition
└── metadata { recordedAt, recordedBy, selfCheck, migratedFrom }
```

**Why this shape.**
- **Targets describe what an operator sees, never DOM position.**
  - `{role:"link", name:"Manage", row:"{{accountType}}"}` means "the Manage link in the row for this account type".
  - `{role:"cell", row:"Savings", column:"Balance"}` or `{role:"cell", label:"Current Balance"}` reads a value by its position in the table's meaning. The literal value seen during discovery is never stored.
  - This removed the bug where a param changed the name but a positional CSS path still clicked the element from discovery.
- **Checkpoints are few and stable.** They use the model's stated expectation only if it really appeared, in one element, and is not table data. Otherwise they use controls and column headers that appeared, plus the URL shape with non-param values wildcarded. They are enforced, not advisory.
- **Runtime conditions live in the app profile, not in each artifact.** "Record not found" means the same thing on every Keystone screen. A per-step `onError` is still available for step-specific meanings.
- **The artifact is reviewable** (the web UI renders its steps) and **callable**: typed params and outputs, and a result contract (§3).
- v1 artifacts load through a migration that drops positional selectors.

## 3. Determinism & error handling

For each step, replay: checks policy → builds the action with params substituted → `act()` → waits (bounded) for the checkpoint → decides. The step ends in exactly one of these ways:

| What is on screen | Result |
|---|---|
| Checkpoint holds, no known condition | next step |
| Known interstitial (profile) | dismiss it (up front if already visible), then retry or re-check; max 2 per step |
| Known condition `business-outcome` | `{status:"business-outcome", outcome:"not-found"}`: a legitimate answer, not an error |
| Known condition `retry` | re-run the step, bounded; **never** for an irreversible step (escalate instead) |
| Known condition `escalate` (e.g. session expired) | human handoff (§5) or `{status:"escalated"}` |
| Unknown blocking UI (overlay covering the target, native dialog) | human handoff or `escalated` |
| Anything else (element missing or ambiguous, checkpoint unmet) | `{status:"failure", stepId, expected, observed, error}` + screenshot |

**Determinism.**
- **One resolver.** Matching is whole-text and case-insensitive, and it never picks "the first of several".
- **No forced clicks.** A forced click lands on whatever covers the target and reports success, which is how the Goodreads sign-up modal silently swallowed clicks.
- **Waits are polls with deadlines, not sleeps.**
- **Native dialogs are dismissed and reported**, never accepted implicitly.
- **A known error page overrides a matching checkpoint**, so a 503 page at the right URL is never a success.

**Verified by:**
- the scenario matrix: happy path for a different member, not found, slow loads, transient 503, known notice, unknown overlay, operator handoff, session expiry, validation error, permission denied, unexpected dialog, unconfirmed irreversible step, row selected by a param. It passed 3 consecutive runs with no flakes.
- `/evidence/demo`: 12 replays of the artifact produced by the real discovery run, plus the open-account fixture.

**Discovery self-checks.** After a successful discovery, the new artifact is replayed once with the discovery params, and the result is stored in `metadata.selfCheck`. Artifacts with irreversible steps are not self-replayed, because that would repeat the real action. Running real discovery against the mock app found several recorder bugs (e.g. the model predicting text that never appeared, copying whole rows into `row`); each is now handled generally and covered by a test.

**Limits.** A missing row such as "member has no Savings account" is reported as a clear hard failure (`No table row containing "Savings"`), not as a business outcome. Expressing "absence means X" needs a per-step condition type we did not build.

## 4. Heterogeneity & multi-tenant

**Surface seam.**
- The artifact and engine only know `Surface.observe()/act()` and `TargetSpec`.
- `{role, name, row, column, label, frame}` maps directly onto Windows UI Automation (ControlType + Name, Grid/Table patterns) and macOS AX (AXRole + AXTitle, AXRows/AXColumns), so a desktop surface would implement the resolver on those APIs.
- Legacy web is already the default case: frames, layout tables, no test IDs, and ARIA gaps covered by label and text fallbacks.
- A surface with no accessible structure (Citrix, canvas) would need a visual resolver behind the same interface. Its `TargetSpec` would stay semantic, with the resolver doing screenshot grounding. We did not build it.

**Multi-tenant reuse (built).** The unit of reuse is the *vendor product*, not the tenant:
- Artifacts are recorded once, against the base product. App profiles hold the product's conditions.
- **Canonical routes.** Checkpoint URLs are recorded as route shapes: param values become `{{param}}`, other ID-like path segments become `:id` (`/member/12345` becomes `/member/:id`), other query values become `*`. A checkpoint recorded on one record holds for every record.
- **Tenant overlays** (`profiles/tenants/<app>/<tenant>.json`) list only what differs for one institution: its host, relabelled UI text (`"Member ID"` → `"Account Holder #"`), route rewrites (`/detail?id=` → `/members/`), extra interstitials, conditions and sensitive fields. `applyTenantOverlay` derives that tenant's artifact and profile at replay time; the recorded artifact is never copied or edited.
- **Demonstrated** on a second tenant, Summit FCU: the same mock product with relabelled fields, member pages under `/members/:id` and its own security reminder. The artifact recorded on Keystone runs there with a short overlay (matrix rows T2/T3, evidence run 14). Semantic targets keep overlays small: branding and layout changes do not affect role and name, and configuration changes show up as label diffs.

**Drift detection falls out of the contract.**
- An enforced checkpoint or an ambiguous or missing target is a precise, per-step signal. Pointing the Keystone artifact at Summit without its overlay fails at step 1 with `checkpoint-failed` (row T1), not somewhere later.
- Replaying each capability per tenant on a schedule, as the scenario matrix does, turns drift into a report instead of a production incident.

**Not built:** per-tenant artifact storage, scheduled drift runs, overlay inheritance (tenant → region → product).

## 5. Escalation & handoff

**Detecting "stuck".** Replay escalates on:
- a profile condition of kind `escalate` (e.g. session expired);
- unknown blocking UI (overlay or native dialog);
- a step that failed to dismiss an interstitial;
- a transient error on an irreversible step;
- an irreversible step the caller did not confirm.

Discovery escalates on dead ends and the step budget.

**Control transfer (real, not mocked).** `EscalationManager` runs a state machine: automation → paused → human → resuming → automation | done. The handoff works like this:
1. Automation pauses on the same browser session.
2. The operator gets an intervention request with capability, step, reason, the current page, a masked screenshot and the CDP endpoint (`replay --handoff` runs headed with CDP on :9222).
3. The surface records the operator's clicks, field edits (targets only, never values) and navigations.
4. The operator signals `done`, `complete` or `abort`.
   - On `done`, automation takes control back: it continues if the step's checkpoint now holds, otherwise it re-runs the step the human unblocked.
   - `complete` means the human finished the task; `abort` stops the run.
   - For an unconfirmed irreversible step, `done` is the human's approval.

Handoffs are limited to two per step. Human actions are returned in the `ReplayResult` and written to evidence with the control-state history.

**Minimal on purpose.** The operator UI is a terminal prompt (`TerminalOperatorChannel`). A web console or work queue implements the same `OperatorChannel` interface. The next step is promotion: turning "the human clicked `Acknowledge` on an unknown overlay" into a proposed profile interstitial for review.

## 6. Safety

**Allowlist.**
- Enforced in both discovery and replay: domains, URL patterns (prefix match) and action types.
- Stored in the artifact, so an artifact cannot navigate outside what it was recorded under.
- The discovery default is the target's own host.

**Risky vs irreversible.**
- Risky actions are allowed and flagged.
- Irreversible actions (e.g. `submit` in `allowlists/keystone-cu.json`) run only when the caller passes `confirmIrreversible` (`--confirm`), meaning the calling agent vouches for the user's consent. Otherwise they go to a human for approval.
- Irreversible steps are never retried automatically, and native confirmation dialogs are never accepted implicitly.
- Discovery self-checks skip artifacts with irreversible steps.

**Data handling.** Regulated values never leave the process or reach disk. Two mechanisms cover them:
- **Fixed patterns:** SSNs and account and card numbers.
- **Profile classification with value propagation:** for what patterns cannot see, such as names and dates of birth. The app profile says where sensitive data sits: fields (columns or labels such as `Name`, `DOB`, `Member`) and patterns with a capture group (`Member Detail - (.+)`). A per-run `SensitiveDataRedactor` learns the actual values as screens are observed, then scrubs them from all text for the rest of the run.

Both apply to the prompt sent to the model provider, step logs, snapshot files, LLM logs and saved artifacts. Screenshots are masked by Playwright over matching and learned text. Human-action capture records targets, never typed values. The server validates artifact and evidence paths against traversal, and validates run requests.

**Limits.**
- A value is only learned once it has appeared in a classified field or pattern. Text shown *before* that, or in places the profile does not describe, is covered only by the fixed patterns, so profiles need review per app.
- `confirmIrreversible` trusts the caller.
- No rate limiting.
- Allowlists are per artifact, not per tenant.

## 7. Cuts

**Stretch goals done (ISM-818):**
- **Agent-facing capability interface.** An MCP server (`list_capabilities`, `run_capability`, `discover_capability`) packaged as a plugin for both Claude Code and Codex, with a skill that tells the agent how to read results and when to ask the user. `run_capability` validates params against each artifact's typed params before any browser starts, and returns the ReplayResult unchanged (evidence runs 15–16).
- **Canonicalization and cross-tenant reuse**, described in §4.

**Left out deliberately:**
- the interactive handoff over MCP (escalations reach the calling agent as `escalated`; the live handoff is CLI-only);
- per-tenant storage and the drift scheduler (designed in §4);
- a desktop or visual surface (the seam and target model are ready);
- a web operator console (the terminal channel implements the real interface);
- conditions of the form "absence means X";
- CI and containerisation.

The first public-site work (Wikipedia, Goodreads) is no longer a target. It is the reason the schema moved to v2 (ADR-015).

**Next, in order:**
1. **Promote human fixes into profiles**: propose an interstitial from a captured handoff, with review before use.
2. **Approval states and replay-stability scores**: draft → approved, where approval requires N green matrix-style replays; `run_capability` would then refuse drafts.
3. **Handoff over MCP**: surface an escalation to the host (MCP elicitation) instead of ending the run.
