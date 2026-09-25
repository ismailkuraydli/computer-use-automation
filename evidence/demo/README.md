# Evidence

Everything here was produced by `scripts/generate-evidence.sh` against the Keystone CU mock app (`npm run mock-app`). Each run directory has:
- `console.txt`: CLI output;
- `structured-log.json`: every step with its result, URL and detail;
- `step-N-ax.json`: the accessibility snapshot after the step;
- `screenshots/`: screenshots with PII masked;
- for discovery, `llm-conversation.json`.

SSNs, account numbers, member names and dates of birth are redacted in every file and masked in screenshots. Names and dates of birth are found through the `sensitive` section of `profiles/keystone-cu.json`.

## The artifact

[`artifacts/lookup-member-savings-balance.json`](artifacts/lookup-member-savings-balance.json) was recorded by run 01 from the goal *"Look up member 23456 and read the balance of their Savings account"*.
- Params: `memberId`. Output: `savingsBalance`.
- The balance is read as `{role: "cell", row: "Savings", column: "Balance"}`, never as the literal value seen during discovery.
- Checkpoints use form controls, column headers and URL shapes with `{{memberId}}`.

[`artifacts/fixtures/`](artifacts/fixtures/) holds the hand-written artifacts used by the scenario matrix, including `open-sub-account` (an irreversible submit).

## Runs

| # | Run | Condition injected | Result |
|---|---|---|---|
| 01 | [discovery](01-discovery/) | none; **real LLM** (`google/gemini-3.5-flash-lite` via OpenRouter) | 4 steps, goal met, output `$8,234.50`. Artifact saved, **self-check replay passed** (`self-check-run/`) |
| 02 | [replay: other member](02-replay-other-member/) | none, `memberId=45678` | `success`, `savingsBalance: $45,200.00`: same artifact, different record |
| 03 | [replay: not found](03-replay-not-found/) | none, `memberId=99999` | `business-outcome: not-found`. A legitimate answer, not a crash |
| 04 | [replay: no savings row](04-replay-no-savings-row/) | none, `memberId=34567` (Checking only) | `failure` at step 5: *No table row containing "Savings"*. Clear, debuggable hard failure |
| 05 | [replay: known notice](05-replay-known-notice/) | blocking "System Notice" overlay on every results page | `success`: the notice is in the app profile, so it is dismissed automatically (see `structured-log.json`) |
| 06 | [replay: slow + 503](06-replay-slow-and-503/) | 2 s per page and one `503 Service Temporarily Unavailable` | `success`: step 1 fails its checkpoint on the 503 page, the profile says `retry`, and the second attempt passes |
| 07 | [replay: session expired](07-replay-session-expired/) | session expires mid-flow | `escalated` at step 4, reason from the profile, `resolution: unresolved` (no operator attached) |
| 08 | [replay: missing param](08-replay-missing-param/) | `params: {}` | `failure` at step 0 (`missing-params`) before any action |
| 09 | [handoff](09-handoff-simulated-operator/) | overlay that is **not** in the profile | escalates twice (`Target is covered by <div id="noticeOverlay">`); a *scripted* operator (`scripts/handoff-demo.ts`) clears it on the live page each time, automation resumes, `success` with both human clicks in `humanActions`. For the real terminal flow, see README step 4 |
| 10 | [open account, unconfirmed](10-open-account-unconfirmed/) | caller did not pass `--confirm` | `escalated` at step 4 **before** the irreversible submit runs |
| 11 | [open account, confirmed](11-open-account-confirmed/) | `--confirm` | `success`, new account number returned (redacted in this log) |
| 12 | [open account, validation error](12-open-account-validation-error/) | `deposit=-5` | `business-outcome: validation-error` |
| 13 | [open account, unexpected dialog](13-open-account-unexpected-dialog/) | native `confirm()` on submit | the dialog is dismissed, **not accepted**; `escalated` with the dialog text as the reason |

The replay engine's full acceptance matrix (16 scenarios) runs as a test: `npm run test:scenarios`.
