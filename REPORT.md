# Computer-Use Automation System — Design Write-Up

The model discovers once. The recorder turns the successful run into a typed capability artifact, and deterministic replay is how an agent invokes it. One rule shapes everything below: **site knowledge lives in data (the artifact and the app profile), never in engine code.** When replay meets something it does not recognize, a human takes over the live session, and their fix can become profile data.

## 1. Architecture

A single TypeScript process with a CLI, a small web UI, and an MCP server. The seams are interfaces, not services:
- **`Surface`** (`PlaywrightSurface`) is the only Playwright code: `observe()` returns an accessibility snapshot and a screenshot, `act()` performs one action on a semantic target, and it captures human actions during a handoff.
- **Discovery:** `AgentLoop` + an OpenRouter model plan and act; the `Recorder` turns successful actions into steps, checkpoints and `{{param}}` templates.
- **`ReplayEngine`** replays with no model: policy check, act, checkpoint, recover, escalate.
- **App profiles** (`profiles/<app>.json`) hold what every screen of one app can show: interstitials and runtime conditions.
- **Agent access:** a capability catalog exposed as MCP tools, shipped as a Claude Code and Codex plugin.

Key decisions:
- **Accessibility tree first.** It is what an operator perceives, it exists on desktop platforms too, and it survives markup churn better than DOM paths.
- **One process, JSON on disk, no agent framework.** The brief rewards design, not infrastructure. Artifacts and profiles are reviewable in a pull request, and the evaluated logic stays visible.
- **A deliberately hostile local target** (framesets, layout tables, no test IDs), not a public site. Public sites fail through A/B layouts and bot detection; the brief's apps fail through runtime conditions. The mock app injects exactly those, and a 19-row scenario matrix (`npm run test:scenarios`) is the replay acceptance gate.

## 2. Artifact schema

```
CapabilityArtifact (schemaVersion "2.0")
├── capability, description, artifactVersion
├── surface { type, baseUrl, app → profiles/<app>.json }
├── params[]  { name, type, required }          ← what the agent supplies
├── outputs[] { name, type }                    ← what the agent gets back
├── allowlist { domains, urlPatterns, actions, irreversibleActions }
├── steps[]
│   ├── action: navigate | click | type | select | extract | submit | …
│   ├── target { role, name?, row?, column?, label?, frame? }   (may use {{param}})
│   ├── value, output
│   ├── checkpoint { anyOf/allOf: [{ urlPattern, textContains, axContains[] }] }
│   ├── onError[] { when, kind: business-outcome | retry | escalate | hard-failure }
│   └── classification: safe | risky | irreversible
├── checkpoint { …, outputsExtracted }          ← final success condition
└── metadata { recordedAt, selfCheck, … }
```

Why this shape:
- **Targets describe what an operator sees, never DOM position.** `{role:"link", name:"Manage", row:"{{accountType}}"}` is "the Manage link in the row for this account type". `{role:"cell", row:"Savings", column:"Balance"}` reads a value by its meaning in the table, so the literal value seen during discovery is never stored.
- **Checkpoints are few, stable and enforced.** They are built from controls and column headers that appeared, the model's stated expectation (kept only if it really appeared and is not record data), and the URL as a route shape (`/member/12345` becomes `/member/:id`).
- **Runtime conditions live in the app profile.** "No records found" means the same thing on every screen of one app; per-step `onError` stays available for step-specific meanings.
- **It is a contract, not a transcript:** typed params and outputs, and the result shape in §3. v1 artifacts are migrated on load.

## 3. Determinism & error handling

For each step, replay checks policy, acts with params substituted, waits (bounded) for the checkpoint, and then ends the step in exactly one way:

| On screen | Result |
|---|---|
| Checkpoint holds, no known condition | next step |
| Known interstitial | dismiss it (up front if already visible), then continue; at most 2 per step |
| Known `business-outcome` condition | `{status:"business-outcome", outcome:"not-found"}`, a legitimate answer |
| Known `retry` condition | re-run the step, bounded; **never** for an irreversible step |
| Known `escalate` condition, or unknown blocking UI (overlay, native dialog) | human handoff (§5), or `{status:"escalated"}` |
| Anything else | `{status:"failure", stepId, expected, observed, error}` plus a screenshot |

Determinism comes from:
- **one strict resolver:** whole-text, case-insensitive matching that never picks "the first of several";
- **no forced clicks:** a forced click lands on whatever covers the target and reports success;
- **polls with deadlines, never sleeps;**
- **native dialogs dismissed and reported,** never accepted;
- **a known error page overriding a matching checkpoint,** so a 503 page at the right URL is never a success.

After discovery, the new artifact is replayed once as a self-check, and the result is stored in `metadata.selfCheck`. Artifacts with irreversible steps are skipped, because replaying would repeat the real action.

Limit: "member has no Savings account" is reported as a precise hard failure, not a business outcome, because conditions of the form "absence means X" are not modelled.

## 4. Heterogeneity & multi-tenant

**Surface seam.** The engine only knows `observe()/act()` and `TargetSpec`.
- `{role, name, row, column, label, frame}` maps onto Windows UI Automation and macOS AX, so a desktop surface would implement the resolver on those APIs.
- Legacy web (frames, layout tables, missing ARIA) is already the default case.
- A surface with no accessibility structure (Citrix, canvas) would need a visual resolver behind the same interface. Not built.

**Multi-tenant reuse (built).** The unit of reuse is the vendor product.
- An artifact is recorded once, against the base product.
- A **tenant overlay** (`profiles/tenants/<app>/<tenant>.json`) lists only what differs for one institution: host, relabelled UI text (`"Member ID"` → `"Account Holder #"`), route rewrites, extra interstitials and sensitive fields. It is applied at replay time; the artifact is never copied.
- Demonstrated on a second tenant, Summit FCU, which relabels fields, moves member pages to `/members/:id` and adds a security reminder. The Keystone artifact runs there through a short overlay.
- **The deployment URL is configuration** (plugin setting `target_url`, `--base-url`), so one capability runs on staging, production or a path-prefixed portal.

**Drift detection** falls out of enforced checkpoints. The Keystone artifact pointed at Summit without its overlay fails at step 1 with `checkpoint-failed`. Scheduled per-tenant replays would turn drift into a report. Not built: per-tenant storage, scheduled drift runs, overlay inheritance.

## 5. Escalation & handoff

Replay escalates on:
- a profile condition of kind `escalate` (e.g. session expired);
- unknown blocking UI;
- a failed dismissal;
- a transient error on an irreversible step;
- an unconfirmed irreversible step.

Discovery stops on dead ends and on its step budget.

**Control transfer is real; only the operator UI is minimal.** `EscalationManager` runs a state machine: automation → paused → human → resuming → automation | done. With `replay --handoff`:
1. Automation pauses on the **same** headed browser session (CDP exposed on :9222).
2. The operator gets the capability, step, reason, page and a masked screenshot.
3. The surface records their clicks, field edits (targets only, never values) and navigations.
4. The operator signals `done`, `complete` or `abort`:
   - `done`: automation takes control back and continues if the step's checkpoint holds, otherwise it re-runs that step. For an unconfirmed irreversible step, `done` is the approval.
   - `complete`: the human finished the task.
   - `abort`: the run stops.

Handoffs are capped at 2 per step, and human actions are returned in the result.

The operator channel is a terminal prompt behind an `OperatorChannel` interface that a web console or queue could implement.

Limit: re-running works when the escalated step can be repeated, such as a navigation. After a session expires mid-flow, the page the step needed is gone. The operator should then finish (`complete`); resuming from the last navigation is future work.

## 6. Safety

- **Allowlist:** domains, URL patterns and action types, enforced in discovery and replay and stored in the artifact.
- **Irreversible actions** run only with `confirmIrreversible` (the caller vouches for user consent); otherwise a human approves them. They are never retried, and native confirmation dialogs are never accepted implicitly.
- **Regulated data never leaves the process or reaches disk.** Fixed patterns catch SSNs and account and card numbers. For names and dates of birth, the app profile declares where sensitive fields sit; a per-run redactor learns those values from each screen and scrubs them everywhere.
  - This covers the prompt sent to the model provider, logs, snapshots and artifacts.
  - Screenshots are masked.
  - Human capture never records typed values.
- **Tool inputs:** MCP inputs name profiles, tenants and allowlists by bare name only, and the web server validates paths against traversal.

Limits:
- Redaction is only as complete as the profile: a value is protected once it has been seen in a classified place.
- `confirmIrreversible` trusts the caller.
- No rate limiting.
- Allowlists are per artifact, not per tenant.

## 7. Cuts

**Stretch goals done:**
- **Agent-facing capability interface:** MCP tools `list_capabilities`, `run_capability` (typed params validated before a browser starts) and `discover_capability`, packaged as a Claude Code and Codex plugin with a usage skill.
- **Canonicalization and cross-tenant reuse** (§4).

**Left out deliberately:**
- the interactive handoff over MCP (the agent receives `escalated`);
- resuming a handoff from the last navigation;
- per-tenant storage and drift scheduling;
- a desktop or visual surface;
- a web operator console;
- "absence means X" conditions;
- CI and containers.

Early work against public sites (Wikipedia, Goodreads) was dropped as a target. It is why the schema moved to semantic targets (ADR-015).

**Next:**
1. Promote a human's fix from a handoff into a proposed profile entry, reviewed before use.
2. Approval states: an artifact becomes runnable unattended after N green replays.
3. Handoff over MCP via elicitation.

Design decisions and alternatives are recorded in [DECISIONS.md](./DECISIONS.md).
