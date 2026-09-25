# Architecture Decision Records

A living log of every significant design decision, the alternatives considered, and the consequences. Updated as the design evolves.

---

### ADR-001: TypeScript + Node.js + Playwright

**Context:** The system needs a runtime that can drive a browser, call an LLM API, serialize artifacts, and run deterministically. The assignment leaves language/runtime open.

**Options considered:**
- **TypeScript/Node.js + Playwright** — typed, Playwright is first-class, matches existing stack
- **Python + Playwright** — richer LLM/agent ecosystem, but weaker typing
- **Go** — fast and typed, but weak LLM agent ecosystem and no native browser automation

**Decision:** TypeScript/Node.js + Playwright.

**Rationale:** Playwright provides the best browser automation API (AX-tree access, iframe/frame traversal, auto-waiting). TypeScript gives us typed contracts for the artifact schema and replay result — critical for the "typed, serializable artifact" requirement. Matches the developer's existing stack (sew-gateway), reducing friction.

**Consequences:** Enables strong typing of artifact schema and contracts. Precludes Python's richer LLM tooling, but we call Claude via raw HTTP/SDK — no heavy agent framework needed. Watch for: Playwright AX-tree API limitations on legacy frameset pages (spike needed).

---

### ADR-002: Hybrid Step-List with State Guards (Option C)

**Context:** The artifact schema is the focal point of evaluation. It must be reviewable by humans, invocable by agents, and robust to runtime errors during replay.

**Options considered:**
- **A: Imperative Step-List** — flat ordered list of actions with per-step error handlers. Simplest, most readable, but happy-path-bound — can't detect mid-flow interruptions.
- **B: State-Machine** — named states with recognition signatures and transitions. Most robust to interruptions, but harder to author/review (graph vs list). Works against the "reviewable" requirement.
- **C: Hybrid — Step-List with State Guards** — ordered steps, each with a pre-execution guard (what the screen must look like) and a post-execution checkpoint. Combines readability of a list with robustness of state-matching.

**Decision:** Option C — Hybrid Step-List with State Guards.

**Rationale:** The assignment requires both reviewability ("a human reviewer and a calling agent should be able to understand what the capability does") and robustness ("a capability that only works on the happy path is not useful in production"). Option C satisfies both: the linear structure is human-readable, while guards and checkpoints detect runtime errors before and after each step. The artifact doubles as a communication medium during human escalation — the operator can see exactly which step failed, what the guard expected, and what was observed instead.

**Consequences:** Enables readable artifacts with robust error detection. Precludes the natural mid-flow recovery of a full state machine (if a dialog appears between steps, we need an explicit guard on the next step to catch it, rather than the state machine re-evaluating from observed state). Watch for: guard definitions becoming verbose — keep them lightweight (key-element presence, not full screen hashes).

---

### ADR-003: AX-Tree-First Locator Strategy with DOM Fallback

**Context:** The target surface is intentionally hostile (framesets, nested tables, no test IDs, non-semantic markup). The locator strategy determines whether replay works next month.

**Options considered:**
- **DOM-first (CSS selectors)** — standard Playwright approach, but fragile on legacy surfaces without stable IDs/classes
- **AX-tree-first (role + name)** — uses the accessibility tree, which is more stable than raw markup and available on both web and desktop
- **Screenshot + coordinates** — most surface-agnostic, but least deterministic (layout-dependent)

**Decision:** AX-tree-first (role + accessible name), with DOM structural fallback (tag + text + tree position), with visual fallback (screenshot region) as last resort.

**Rationale:** The AX tree is the most stable representation that works across surfaces (web, legacy web, desktop via OS accessibility APIs). It's what a screen reader uses — if a human can identify a control by its announced name and role, our locator can too. DOM fallback handles cases where the AX tree is ambiguous (multiple elements with same role+name). Visual fallback is last resort for completely non-semantic surfaces.

**Consequences:** Enables surface-agnostic locators that generalize to desktop (AX APIs exist on macOS/Windows). Precludes pure-DOM approaches that would break on legacy markup. Watch for: AX-tree availability inside framesets — Playwright's `page.accessibility.snapshot()` may not traverse frames; need to walk frame tree manually (spike candidate).

---

### ADR-004: Three-Tier Error Taxonomy (Business Outcome / Recoverable / Hard Failure)

**Context:** The assignment explicitly requires distinguishing "expected business outcomes" (member-not-found is a legitimate result, not a crash) from "recoverable conditions" (dismiss a dialog, wait for a load) from "hard failures" (stop and surface a debuggable error).

**Options considered:**
- **Binary (success/failure)** — simplest, but conflates "member not found" with "element not found"
- **Three-tier (business outcome / recoverable / hard failure)** — matches the assignment's taxonomy exactly
- **Four-tier (add "warning")** — over-engineered for the scope

**Decision:** Three-tier error taxonomy:
1. **Business outcome** — legitimate result the caller needs to know (member-not-found, validation-error, permission-denied, already-exists). Replay returns `{ status: "business-outcome", outcome: string }`.
2. **Recoverable condition** — system can handle and continue (unexpected-dialog → dismiss + retry; slow-load → wait + retry; session-expired → escalate or re-auth). Defined per-step in artifact `onError` handlers.
3. **Hard failure** — stop and escalate (locator-not-found, unexpected-state, checkpoint-failed-with-no-handler). Replay returns `{ status: "failure", step, expected, observed, error }`.

**Rationale:** Directly maps to the assignment's requirement. The distinction between business outcome and failure is "the most common design mistake" per the glossary — we make it structurally impossible to conflate them by having distinct result types.

**Consequences:** Enables clean caller contracts — the agent invoking a capability gets typed outcomes, not exceptions. Precludes catch-all error handling — every error must be classified. Watch for: new error types discovered during real runs that don't fit any tier — add them to the taxonomy deliberately, don't force-fit.

---

### ADR-005: Allowlist + Action Classification Safety Model

**Context:** The system operates on regulated financial data. It needs an allowlist of permitted actions/domains and must handle risky/irreversible actions conservatively.

**Options considered:**
- **Allowlist only** — permit listed domains + action types, block everything else
- **Allowlist + action classification** — allowlist for scope, plus tiered action classification (safe/risky/irreversible)
- **Capability-level policy** — each artifact declares its own policy (too decentralized for the security model)

**Decision:** Allowlist + action classification:
- **Allowlist**: configured per-capability — permitted URL patterns + permitted action types. Agent cannot navigate or act outside the allowlist.
- **Action classification**:
  - `safe`: read, navigate, type (input), wait, extract — auto-execute
  - `risky`: submit, click-confirm, click-action-button — flag in evidence, execute only if artifact explicitly declares the action
  - `irreversible`: delete, transfer, approve — always escalate to human before executing
- **PII redaction**: before writing to artifacts or evidence, redact patterns matching SSN, account numbers, card numbers, credentials/tokens. Configurable redaction patterns. Original values never persisted — only parameterized placeholders (`{{memberId}}`) in artifacts.

**Rationale:** Allowlist prevents the agent from wandering outside scope. Action classification ensures irreversible financial actions always get human approval. PII redaction is non-negotiable for regulated financial data — the artifact should never contain real member data, only parameter references.

**Consequences:** Enables auditable safety — every action is classified and logged. Precludes fully autonomous operation on irreversible actions (by design). Watch for: allowlist being too permissive — review each capability's allowlist during the artifact approval step.

---

### ADR-006: Live-Session Control Transfer via CDP

**Context:** When the system is stuck, a human must take control of the *same live session* — not a fresh one — perform manual steps, and hand control back. The assignment says "make the handoff mechanism and the control-transfer model real and well-reasoned."

**Options considered:**
- **CDP (Chrome DevTools Protocol) endpoint** — expose the live Playwright browser's CDP endpoint; operator connects with a real Chrome instance to the same browser session
- **Web-based operator console** — build a web UI that proxies the live session (co-browsing)
- **VNC/remote desktop** — share the screen of the machine running the browser

**Decision:** CDP endpoint exposure + minimal CLI operator interface. The Playwright browser is launched with `--remote-debugging-port`. When escalation occurs:
1. EscalationManager pauses automation (stops the agent loop / replay engine)
2. Exposes the CDP endpoint URL + a session token
3. Operator connects to the same browser via Chrome (`chrome --remote-debugging-port=...`) or a minimal web-based viewer
4. A control-state machine tracks who is in control: `automation → paused → human → resuming → automation`
5. During human control, a Playwright listener records clicks/types/navigations as "human-assisted steps" in evidence
6. Human signals done → EscalationManager verifies current state against the artifact's checkpoint for the current step → resume or complete

**Rationale:** CDP is the native, real mechanism for connecting to a live Chromium session. It requires no custom co-browsing infrastructure. The operator gets a real browser to interact with — not a mock. The control-state machine makes "who is in control" explicit and verifiable, which the assignment asks for.

**Consequences:** Enables real control transfer on the same live session. Precludes a polished operator console (we mock the UI but make the mechanism real — exactly what the assignment asks). Watch for: CDP security — the debugging port should only be exposed locally, not to the network.

---

### ADR-007: Single Process, CLI-Driven, JSON File Storage

**Context:** This is a take-home project evaluated on design judgment, not infrastructure. The assignment explicitly says "We do not reward building scaling infrastructure."

**Options considered:**
- **Single process, CLI-driven, JSON files** — one Node.js process, CLI commands for discovery/replay, JSON files for artifacts and evidence
- **Multi-service (discovery service + replay service + artifact registry)** — cleaner separation, but premature for the scope
- **Dockerized microservices** — over-engineered

**Decision:** Single process, CLI-driven, JSON file storage. The design has clean seams (interfaces) that *could* split into services later, but we build one process.

**Rationale:** The assignment evaluates the quality of abstractions, not infrastructure. A single process with well-defined interfaces demonstrates the design without wasting effort on deployment plumbing. JSON files for artifacts make them human-readable and git-versionable — directly supporting the "reviewable" requirement.

**Consequences:** Enables fast iteration and easy evidence collection. Precludes horizontal scaling (by design — the design supports it, the implementation doesn't). Watch for: keeping the seams clean — the ReplayEngine, ArtifactStore, and EscalationManager must be interface-driven so they could split later.

---

### ADR-008: Surface Abstraction via Observe/Act Interface

**Context:** The system must implement against one surface (web), but the design must credibly extend to legacy web and desktop. The core abstractions must not paint us into a corner.

**Options considered:**
- **Playwright-specific throughout** — fastest to build, but couples everything to web
- **Surface interface (observe/act) with Playwright implementation** — define a `Surface` interface: `observe() → ScreenState`, `act(Action) → Result`. PlaywrightSurface implements it. A future DesktopSurface (via OS accessibility APIs) could too.
- **Plugin architecture** — over-engineered for the scope

**Decision:** Define a `Surface` interface with `observe()` and `act()` methods. The artifact's actions and guards reference surface-agnostic concepts (role, name, action type) — never Playwright-specific APIs. PlaywrightSurface implements the interface for web. The design document describes how a DesktopSurface would implement the same interface.

**Rationale:** The artifact schema must be surface-agnostic to support multi-tenant reuse across different app types. By defining the surface as an interface, the artifact, replay engine, and error classifier never depend on Playwright directly — only on the interface. This is the seam the assignment asks for in Section 3.7.

**Consequences:** Enables extending to desktop without changing the artifact schema or replay engine. Precludes using Playwright-specific features directly in the replay engine (must go through the interface). Watch for: the interface being too leaky — if we find Playwright concepts bleeding into the artifact, the abstraction is wrong.

---

### ADR-009: Multi-Tenant Reuse via Base Artifact + Per-Tenant Overrides

**Context:** Hundreds of tenants run ~20 apps each, many sharing the same vendor product configured/branded/versioned differently. Artifacts should be reusable across tenants running the same app.

**Options considered:**
- **One artifact per tenant** — simplest, but doesn't scale (thousands of artifacts)
- **Base artifact + per-tenant overrides** — a base artifact defines the flow; per-tenant overrides patch specific locators/URLs/labels
- **Parameterized templates with tenant resolution** — most flexible, but complex to implement

**Decision (design-level, not built):** Base artifact + per-tenant overrides. The artifact schema supports:
- **Base artifact**: the flow for a vendor product (e.g. "lookup member balance on Fiserv DNA")
- **Tenant overrides**: a patch document that overrides specific steps' locators, URLs, or labels for a specific tenant's configuration
- **Version detection**: each artifact declares the app version it was recorded against; replay checks version compatibility and warns on mismatch
- **Canonicalization**: concrete routes/values are normalized to patterns (`/member/12345` → `/member/:id`) so the same artifact works across tenants with different URL structures

**Rationale:** This is the 80/20 of multi-tenant reuse. Most of the flow is identical across tenants running the same vendor product — only specific locators (branded labels), URLs (tenant-specific domains), and labels differ. Override patches handle these without re-recording. The assignment says "design, not necessarily build" — we implement the schema support but stub the override resolution.

**Consequences:** Enables cross-tenant reuse without per-tenant rebuilds. Precludes automatic drift detection (design-only — would need a scheduled re-validation runner). Watch for: override conflicts — two tenants overriding the same step in incompatible ways.

---

### ADR-010: LLM Isolation — Mock in Tests, Real Only for Manual Discovery

**Context:** The discovery run needs a real LLM (Claude via OpenRouter), but automated tests must not burn tokens. The user wants to test the LLM path by hand first.

**Decision:** The AgentLoop depends on an `LLMClient` interface. In tests, a `MockLLMClient` returns scripted responses. The real `OpenRouterClient` is only used for manual discovery runs via CLI. No test ever makes a real API call.

**Rationale:** Token cost control + test determinism. Mocked LLM responses make tests fast, free, and reproducible. The interface seam means we can swap in the real client for the actual discovery run without changing any code.

**Consequences:** Enables testing the full agent loop without API costs. Precludes testing real LLM behavior in CI (by design — the user tests that by hand). Watch for: mock responses drifting from real model behavior — keep mocks representative of actual Claude tool-use format.

---

### ADR-011: CDP AX Tree for observe(), Playwright getByRole/getByText for act()

**Context:** The original AX tree builder used a JavaScript-based approach — a custom function evaluated in the browser that walked the DOM and extracted role+name from aria-label, role attributes, and implicit semantics. This approach broke repeatedly in real-world testing:

- Wikipedia's appearance settings (Small/Standard/Large, Standard/Wide, Automatic/Light/Dark) are label/span elements without aria-label — the JS builder couldn't see them
- Custom widgets with role="button" divs, toggle switches, menu items, and shadow DOM components all use different patterns for accessible names
- Each new website exposed a new element type the JS builder didn't handle, requiring a patch

The fundamental problem: the JS builder was reimplementing what the browser already computes — the accessibility tree. The browser's real AX tree handles all element types, ARIA attributes, shadow DOM, and computed names automatically.

**Options considered:**
- **JS-based AX tree builder (original)** — custom function walks DOM, extracts role+name manually. Fragile: needs patching for every new element type (labels, spans, role'd divs, shadow DOM, custom widgets). We kept hitting edge cases on real websites.
- **CDP Accessibility.getFullAXTree** — Chrome DevTools Protocol returns the browser's real accessibility tree. Handles all element types automatically. But doesn't traverse iframes (each frame needs its own CDP session, which isn't supported for iframe content).
- **Hybrid: CDP for observe() + Playwright getByRole/getByText for act()** — use CDP's real AX tree for the main frame (handles all element types), fall back to the JS builder only for iframe content. For act(), use Playwright's native getByRole (which also uses the browser's real AX tree) with getByText as a last-resort fallback.

**Decision:** Hybrid approach — CDP Accessibility.getFullAXTree for observe() (main frame), JS builder fallback for iframes, Playwright getByRole + getByText for act().

**Rationale:** The browser's accessibility tree is the authoritative source — it's what screen readers use, it handles all element types, ARIA attributes, shadow DOM, and computed names. Reimplementing it in JS was a losing battle. CDP gives us the real tree for the main frame. Playwright's getByRole uses the same real AX tree for element interaction. The JS builder is kept only as a fallback for iframe content (CDP doesn't traverse frames automatically).

**Consequences:** Eliminates the entire class of "AX tree builder can't see this element type" bugs. The LLM sees every accessible element on the page, including labels, spans, custom widgets, and role'd divs. act() uses Playwright's real AX tree for clicking/typing/extracting, with getByText as a last resort for elements that getByRole misses. Watch for: CDP AX tree node format differs from our AXNode type — needs a converter. CDP may include ignored/hidden nodes that should be filtered. On large pages (Wikipedia has 11000+ AX nodes), the LLM only sees a subset — interactive elements are prioritized over StaticText and generic containers, and elements matching the current sub-goal's keywords are boosted to the top so the LLM sees the most relevant controls first regardless of page size.

---

### ADR-012: Sub-goals and goal-aware AX prioritization

**Context:** The LLM kept skipping steps in multi-step goals. For example, a goal like "find the page on flowers, set appearance to small/standard/large, set width, set color, then extract research text" — the LLM would do the search and immediately extract, skipping all 9+ setting changes. Two root causes:

1. **No sub-goal tracking**: The LLM got one big goal string and decided for itself when it was "done." It declared goalMet=true prematurely because there was no structured tracking of what was completed.

2. **Static AX prioritization**: The prioritizer put radio buttons first (good for settings) but if the current sub-goal was to search, the search box should be prioritized over radio buttons. The prioritization was not aware of what the LLM was currently trying to do.

**Options considered:**
- **Sub-goals only** — decompose the goal into ordered sub-goals, track completion, prevent goalMet until all are done. But the LLM still might not see the right elements if prioritization is static.
- **Goal-aware prioritization only** — boost elements matching keywords in the goal. But without sub-goal tracking, the LLM still declares "done" prematurely.
- **Both** — decompose into sub-goals with keywords, track completion, and boost AX elements matching the current sub-goal's keywords.

**Decision:** Both — sub-goals from plan() + goal-aware AX prioritization.

The plan() call now decomposes the goal into ordered sub-goals, each with:
- `id`: sequential identifier
- `description`: what to do for this sub-goal
- `keywords`: words from the AX tree relevant to this sub-goal (e.g. "Search Wikipedia", "textbox" for a search sub-goal; "Appearance", "Small", "radio" for a settings sub-goal)

The AgentLoop tracks completed sub-goals and prevents goalMet=true until all are done. The LLM can signal subGoalComplete=true to advance to the next sub-goal.

The AX prioritizer boosts elements matching the current sub-goal's keywords to the top of the tree, so the LLM sees the most relevant elements first regardless of page size.

**Rationale:** Sub-goals solve the "skipping steps" problem — the AgentLoop enforces completion order. Goal-aware prioritization solves the "can't see the right elements" problem — the LLM sees what's relevant to the current step, not a static ordering that may be wrong for different sub-goals.

**Consequences:** The LLM is now guided through complex multi-step goals with explicit progress tracking. Each decide() call includes the full sub-goal list with completion status (DONE/CURRENT/PENDING), the current sub-goal description, and AX elements prioritized by the current sub-goal's keywords. This means a search sub-goal will show the search box first, and a settings sub-goal will show the radio buttons first — the prioritization adapts to what the LLM is doing. Watch for: the LLM may not correctly identify sub-goal boundaries — if it sets subGoalComplete too early or too late, the tracking will be wrong. The keywords come from the plan() LLM call, which may not perfectly match the actual AX tree element names.

---

### ADR-013: Output verification + new action types (scroll, read_page_text)

**Context:** The LLM extracted "Flower" (the page title heading) instead of the actual research text. It declared goalMet=true without verifying that the output matched what the user asked for. The LLM also had no way to scroll the page or read all visible text — it was limited to the AX tree's first 100 elements.

**Options considered:**
- **Native function calling** — use the model's tool-use API for scroll/read_page_text. More structured but requires different API formats per model.
- **Prompt-based tools** — add scroll and read_page_text as new Action types. The LLM returns them as actions, the Surface executes them. Simpler, works with any model.

**Decision:** Prompt-based tools + output verification.

**New action types:**
- `scroll` — scrolls the page down or up (720px per scroll). Use when content is below the fold.
- `read_page_text` — reads all visible text on the page (using `document.body.innerText`, limited to 5000 chars). Use when the AX tree doesn't show the content the LLM needs.

**Output verification:**
- The LLM response now includes `outputComplete: true|false`
- After extracting a value, the extracted text is shown in the history ("Extracted: '...'") so the LLM can review it
- The AgentLoop prevents `goalMet=true` if `outputComplete === false` — the LLM must confirm the output satisfies the goal
- If the LLM says `outputComplete: false`, the run continues — the LLM can scroll down, read more content, or extract from another element

**Rationale:** The LLM needs both the ability to access more content (scroll, read_page_text) and the judgment to verify its output. Prompt-based tools work with any OpenRouter model without API format changes. Output verification prevents the recurring problem of the LLM extracting a title or link label and declaring success.

**Consequences:** The LLM can now scroll pages, read all visible text, and verify its output before declaring success. This should prevent the "extracted 'Flower' instead of the research text" problem. Watch for: scroll and read_page_text are not recorded in the artifact (they're discovery-only tools, not replayable steps — replay uses the locators from the recorded steps). The outputComplete signal is per-extract — if the LLM extracts multiple outputs, each must be verified.

---

### ADR-014: Mock back-office app as the primary target, gated by a scenario matrix

**Context:** After the core landed, most commits were fixes for one public site's quirks (Wikipedia dropdowns, Goodreads A/B layouts, sign-up modals, bot detection). The brief says the real environment is the opposite: stable enterprise UIs whose hard problems are *runtime conditions* (not found, validation, permission denied, unexpected dialogs, session expiry, slow or failed loads).

**Decision:** The Keystone CU mock app (legacy tables, iframes, no test IDs) is the primary target. It injects the brief's runtime conditions per instance (`createMockApp().setFaults`, or `POST /__faults`). `src/scenarios/scenario-matrix.test.ts` replays fixed artifacts under each condition and asserts the exact `ReplayResult`; every engine change must keep it green. Rows that fail are declared as known gaps (`it.fails`) with the reason, so a fix flips them loudly.

**Consequences:** Progress is measured against a fixed set of conditions instead of whichever site broke last. Public sites become a demonstration of the escalation path for unknown UI, not a source of engine special cases.

---

### ADR-015: Artifact schema v2 — semantic targets, enforced checkpoints, app profiles

**Supersedes:** the DOM-identity parts of ADR-003, the pre-step guards of ADR-002, and the handler kinds of ADR-004.

**Context:** v1 targets carried positional CSS paths (`a:nth-of-type(7)`) that picked the discovery element regardless of params; checkpoints were auto-built from whatever links were on the page and had been made non-fatal; the "recoverable" tier was classified but never executed; runtime-condition handlers only existed if discovery happened to see the error; two element finders disagreed.

**Decision:**
- **Targets** say what an operator sees: `role` + `name`, optional `row` (the table row containing a cell), `column` (the cell under a header) or `label` (the value next to a label), and `frame`. Matching is whole-text and case-insensitive; ambiguity is an error, never "the first match". One resolver, in the surface.
- **Checkpoints** are enforced after every step with a bounded wait. The recorder builds them from stable evidence only: the model's `expect` (kept only if it is on the page, in one element, and not table data), controls and column headers that appeared, and the URL shape with non-param values wildcarded.
- **App profiles** (`profiles/<app>.json`) hold interstitials to dismiss and runtime conditions (`business-outcome | retry | escalate | hard-failure`), shared by every artifact for that app. A known error page overrides a matching checkpoint.
- **Unknown blocking UI** (overlay, native dialog) escalates; everything else unrecognized is a hard failure with expected vs observed. Irreversible steps are never retried and need caller confirmation.
- v1 artifacts are migrated on load (positional selectors dropped).

**Consequences:** Site knowledge lives in data. A new popup or error page is a profile entry, or an escalation whose human fix can be promoted into the profile — never an engine change. The same profile is the unit of multi-tenant reuse (vendor profile + tenant overlay).

---

### ADR-016: Handoff on the live replay session

**Supersedes:** the separate-browser `cua escalate` flow of ADR-006 (the state machine is kept).

**Decision:** `ReplayEngine` routes every escalation through an optional handoff (`EscalationManager.handoff`): pause, send an intervention request (capability, step, reason, screenshot, CDP endpoint) through an `OperatorChannel`, capture the human's clicks/edits/navigations on the *same* page (never typed values), then on `done` verify the step's checkpoint and continue (or re-run the step the human unblocked); `complete`/`abort` end the run with that resolution. An unconfirmed irreversible step becomes a human approval. Bounded to two handoffs per step. `replay --handoff` wires a terminal operator channel.

**Consequences:** The control transfer is real end to end; only the operator UI is minimal (a terminal prompt). A web console or queue can implement `OperatorChannel` without touching the engine.

---

### ADR-017: Sensitive data classified in the app profile, learned per run

**Context:** Pattern redaction catches SSNs and account numbers but not names or dates of birth, which reached LLM prompts, logs and screenshots.

**Decision:** The app profile declares where sensitive data sits (`sensitive.fields`: column headers or labels; `sensitive.patterns`: regexes with a sensitive capture group). One `SensitiveDataRedactor` per run learns the actual values from each observed screen and scrubs them from all text afterwards: the LLM prompt, evidence, artifacts and screenshot masks. It keeps the fixed patterns too.

**Consequences:** No named-entity guessing and no over-redaction of ordinary text. It is as complete as the profile: a value is protected once it has been seen in a classified place, so profiles need per-app review.

---

### ADR-018: Capability catalog as an MCP server, packaged for Claude Code and Codex

**Context:** The stretch goal asks for an agent-facing interface: discover capabilities and invoke them by name with typed args. The user wants to call discovery and replay from Claude Code and Codex.

**Decision:** One stdio MCP server (`src/mcp`) with three tools: `list_capabilities`, `run_capability`, `discover_capability`. It uses a generic `run_capability` rather than one tool per capability, because it behaves the same in every host and needs no tool-list-changed support. The catalog gives each capability's params as JSON Schema, and the server validates params against the artifact's `ParamSpec` before a browser starts. The repo root is a plugin for both hosts (`.claude-plugin/`, `.codex-plugin/` + `codex-mcp.json`, marketplaces, a shared skill), launched by `bin/cua-mcp`, which installs dependencies and Chromium on first start. The CLI and the MCP server share `replay-service` and `discovery-service`. Data lives in `CUA_WORKSPACE`.

**Consequences:** An agent gets a typed, deterministic tool instead of re-reasoning about the UI. Escalations reach the agent as results; the live handoff stays CLI-only until MCP elicitation is wired. Discovery through MCP costs model tokens, so the skill tells the agent to prefer existing capabilities. `tsx` became a runtime dependency because the plugin runs TypeScript directly.

---

### ADR-019: Canonical route patterns and tenant overlays

**Context:** Many institutions run the same vendor product, configured differently. Re-recording per tenant does not scale, and a checkpoint that encodes one record's ID does not generalize.

**Decision:** Checkpoint URLs are recorded as route shapes (`{{param}}`, `:id` for other ID-like segments, `*` for other query values). Tenant overlays (`profiles/tenants/<app>/<tenant>.json`) list only a tenant's differences: host, relabelled UI text, route rewrites, extra interstitials, conditions and sensitive fields. `applyTenantOverlay` is a pure function applied at replay time (`--tenant`, `run_capability.tenant`).

**Consequences:** One recorded artifact serves every tenant of a product; per-tenant work is a short, reviewable data file. Without an overlay, drift fails precisely at the first changed step. Not yet: overlay inheritance, per-tenant storage, scheduled drift runs.

---

### ADR-020: The application URL is deployment configuration, not part of the capability

**Context:** Artifacts record the URL they were discovered on (the local mock app). Installed as a plugin, the same capability must run against wherever the application actually lives: staging, production, a path-prefixed portal.

**Decision:** The plugin setting `target_url` (env `CUA_TARGET_URL`; CLI `--base-url`) says where the app runs. `rebaseArtifact` moves an artifact onto it: host and path prefix in navigation steps, checkpoint URL patterns and the allowlist. A tenant overlay's own `baseUrl` takes precedence (it names a different institution's host); without either, the recorded URL is used. Discovery starts at the configured URL, and `target` may be a path on it. Starting the mock app from the plugin was rejected: it is a test fixture, not the product.

**Consequences:** One recorded capability runs unchanged across deployments. The allowlist follows the configured host automatically, so the setting is trusted configuration (set by the user in the plugin UI or the environment, never by a tool call).
