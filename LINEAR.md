# Linear Project: Computer-Use Automation System

**Linear Project ID:** d870564d-2fa0-4cea-a72f-ee44acea642e
**Linear URL:** https://linear.app — Project "Computer-Use Automation System" under team ISM

## Tickets

| Phase | Ticket | Title | Priority | Status |
|---|---|---|---|---|
| 1 | ISM-813 | Foundation — Surface Interface, Mock App, Locator Strategy | Urgent (1) | Backlog |
| 2 | ISM-814 | Discovery — LLM Agent Loop, Recorder, Safety, Evidence | High (2) | Backlog |
| 3 | ISM-815 | Replay — Deterministic Engine, Error Taxonomy, Result Contract | High (2) | Backlog |
| 4 | ISM-816 | Escalation — CDP Control Transfer, Human Action Recording | Medium (3) | Backlog |
| 5 | ISM-817 | Integration and Evidence — CLI, REPORT.md, README.md, GitHub | Medium (3) | Backlog |
| 6 | ISM-818 | Stretch Goals (optional) — Agent Catalog, Canonicalization, or Stability | Low (4) | Backlog |

## Dependencies

```
Phase 1 (ISM-813) ──blocks──> Phase 2 (ISM-814) ──blocks──> Phase 3 (ISM-815)
                                      │                           │
                                      └──blocks──> Phase 4 (ISM-816) <──┘
                                                       │
                                                       v
                                              Phase 5 (ISM-817)
                                                       │
                                                       v
                                              Phase 6 (ISM-818, optional)
```

## Files

- `ARCHITECTURE.md` — Full architecture spec (requirements, components, contracts, data flow, failure modes, deployment, ADRs, open questions, implementation plan)
- `DECISIONS.md` — 10 ADRs covering every major design decision
- `LINEAR.md` — This file (ticket summary)
