---
name: computer-use-automation
description: Run or record UI automations for web apps that have no API (back-office screens, legacy portals) through the computer-use-automation MCP tools. Use when the user wants to look something up, fill a form or perform a task inside such an app, or to turn a new task into a reusable capability.
---

# Computer-use automation

The `computer-use-automation` MCP server exposes recorded UI automations
("capabilities") as tools. Replay is deterministic and uses no model; only
discovery uses an LLM.

## Tools

- `list_capabilities` — saved capabilities with their params (JSON Schema),
  outputs, version and whether they contain irreversible steps. Call it first.
- `run_capability` — `{ name, params, version?, tenant?, confirmIrreversible? }`.
  Params must match the schema exactly (names and types).
- `discover_capability` — `{ goal, target, app?, allowlist? }`. Records a new
  capability from a goal with example values, replays it once as a self-check,
  and saves it. Takes minutes and costs model tokens; prefer an existing
  capability when one fits.

## Reading results

`run_capability` returns one of:

- `success` — use `outputs`.
- `business-outcome` — a legitimate answer such as `not-found` or
  `validation-error`. Report it; do not retry.
- `failure` — the capability could not complete; `stepId`, `expected` and
  `observed` say where and why. Do not retry blindly; report it with the
  `evidencePath`.
- `escalated` — a person is needed (session expired, unknown popup, an
  irreversible step that was not confirmed). Tell the user the `reason`.

## Rules

- Never set `confirmIrreversible: true` unless the user explicitly approved
  that specific action (for example, opening an account) in this conversation.
- Do not guess param values. Ask the user for missing ones.
- `tenant` selects an institution-specific overlay (same product, configured
  differently); only pass it when the user names that institution.
- Outputs may contain customer data. Show only what the user asked for.
