/**
 * Scenario matrix — the acceptance gate for deterministic replay.
 *
 * Each row replays a fixed artifact against a fresh instance of the Keystone
 * mock app with one runtime condition injected, and asserts the ReplayResult
 * the caller must receive. The conditions come from the assignment brief:
 * record not found, validation error, permission denial, unexpected dialog,
 * session timeout, slow or failed loads, plus a param that selects which
 * element to act on.
 *
 * Rows that fail today are declared with `knownGap` and run as `it.fails`:
 * the suite stays green, and a row that starts passing fails loudly so its
 * gap marker gets removed in the same change that fixed it.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createMockApp, type MockApp, type MockFaults } from "../../mock-app/app.js";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { EvidenceCollector } from "../evidence/evidence-collector.js";
import { ReplayEngine } from "../replay/replay-engine.js";
import type { ReplayResult } from "../replay/result.js";
import type { CapabilityArtifact } from "../artifact/types.js";
import {
  lookupSavingsBalance,
  openSubAccount,
  manageAccountByType,
  DISMISS_NOTICE_HANDLER,
} from "./mock-app-artifacts.js";

type ExpectedResult =
  | { status: "success"; outputs: Record<string, string> }
  | { status: "business-outcome"; outcome: string }
  | { status: "escalated" };

interface Scenario {
  id: string;
  title: string;
  artifact: (baseUrl: string) => CapabilityArtifact;
  params: Record<string, string>;
  faults?: MockFaults;
  expected: ExpectedResult;
  /** Why the current engine fails this row. Remove once fixed. */
  knownGap?: string;
}

const SCENARIO_TIMEOUT_MS = 90_000;

const withNoticeHandler = (base: string) => lookupSavingsBalance(base, { extraHandlers: [DISMISS_NOTICE_HANDLER] });

const SCENARIOS: Scenario[] = [
  // --- lookup-savings-balance ---
  {
    id: "L1",
    title: "happy path, member used during discovery",
    artifact: lookupSavingsBalance,
    params: { memberId: "12345" },
    expected: { status: "success", outputs: { savingsBalance: "$12,847.00" } },
  },
  {
    id: "L2",
    title: "happy path, different member",
    artifact: lookupSavingsBalance,
    params: { memberId: "23456" },
    expected: { status: "success", outputs: { savingsBalance: "$8,234.50" } },
    knownGap: `extract locator is the literal value recorded in discovery ("$12,847.00"), not a position relative to the "Savings" row`,
  },
  {
    id: "L3",
    title: "record not found",
    artifact: lookupSavingsBalance,
    params: { memberId: "99999" },
    expected: { status: "business-outcome", outcome: "not-found" },
  },
  {
    id: "L4",
    title: "slow page loads (2.5s per page)",
    artifact: lookupSavingsBalance,
    params: { memberId: "12345" },
    faults: { slowMs: 2500 },
    expected: { status: "success", outputs: { savingsBalance: "$12,847.00" } },
  },
  {
    id: "L5",
    title: "transient 503 on first load",
    artifact: lookupSavingsBalance,
    params: { memberId: "12345" },
    faults: { transientErrors: 1 },
    expected: { status: "success", outputs: { savingsBalance: "$12,847.00" } },
    knownGap: `"recoverable" handlers (retry) are classified but never executed; replay fails at step 2`,
  },
  {
    id: "L6",
    title: "known notice overlay blocks the results page",
    artifact: withNoticeHandler,
    params: { memberId: "12345" },
    faults: { interstitialPaths: ["/search"] },
    expected: { status: "success", outputs: { savingsBalance: "$12,847.00" } },
    knownGap: `force-click on "Search" lands on the overlay and reports ok; the search never runs, and dismiss handlers are never executed`,
  },
  {
    id: "L7",
    title: "unknown overlay blocks the results page",
    artifact: lookupSavingsBalance,
    params: { memberId: "12345" },
    faults: { interstitialPaths: ["/search"] },
    expected: { status: "escalated" },
    knownGap: `force-click on "Search" lands on the overlay and reports ok; replay fails two steps later instead of escalating`,
  },
  {
    id: "L8",
    title: "session expires mid-flow",
    artifact: lookupSavingsBalance,
    params: { memberId: "12345" },
    faults: { expireSessionAfter: 2 },
    expected: { status: "escalated" },
  },

  // --- open-sub-account ---
  {
    id: "A1",
    title: "happy path reaches confirmation",
    artifact: openSubAccount,
    params: { memberId: "12345", deposit: "500" },
    expected: { status: "success", outputs: { confirmation: "Sub-Account Opened Successfully" } },
  },
  {
    id: "A2",
    title: "validation error on bad deposit",
    artifact: openSubAccount,
    params: { memberId: "12345", deposit: "abc" },
    expected: { status: "business-outcome", outcome: "validation-error" },
  },
  {
    id: "A3",
    title: "permission denied for restricted member",
    artifact: openSubAccount,
    params: { memberId: "34567", deposit: "500" },
    expected: { status: "business-outcome", outcome: "permission-denied" },
  },
  {
    id: "A4",
    title: "unexpected confirm() dialog on an irreversible submit",
    artifact: openSubAccount,
    params: { memberId: "12345", deposit: "500" },
    faults: { confirmOnSubmit: true },
    expected: { status: "escalated" },
    knownGap: `Playwright silently dismisses the confirm() dialog, so the submit is cancelled; replay only notices one step later as element-not-found`,
  },

  // --- manage-account-by-type ---
  {
    id: "M1",
    title: "param selects the row (Savings is not the first row)",
    artifact: manageAccountByType,
    params: { memberId: "12345", accountType: "Savings" },
    expected: { status: "success", outputs: { balance: "$12,847.00" } },
    knownGap: `ambiguous "Manage" links resolve to the first row (Checking); the artifact cannot bind a param to row context`,
  },
  {
    id: "M2",
    title: "param selects the row, different member",
    artifact: manageAccountByType,
    params: { memberId: "45678", accountType: "Checking" },
    expected: { status: "success", outputs: { balance: "$2,340.00" } },
    knownGap: `ambiguous "Manage" links resolve to the first row, and the extract target is the literal discovery value`,
  },
];

let mock: MockApp;
let server: Server;
let baseUrl: string;
let evidenceRoot: string;

beforeAll(async () => {
  mock = createMockApp();
  server = await new Promise<Server>((resolve) => {
    const s = mock.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  evidenceRoot = mkdtempSync(path.join(tmpdir(), "scenario-matrix-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(evidenceRoot, { recursive: true, force: true });
});

afterEach(() => mock.resetFaults());

async function replay(scenario: Scenario): Promise<ReplayResult> {
  mock.setFaults(scenario.faults ?? {});
  const evidence = new EvidenceCollector(evidenceRoot);
  const surface = new PlaywrightSurface({ headless: true, screenshotDir: evidence.screenshotDir });
  await surface._start();
  try {
    const engine = new ReplayEngine({ surface, evidenceCollector: evidence });
    return await engine.run(scenario.artifact(baseUrl), scenario.params);
  } finally {
    await surface.close();
  }
}

describe("Scenario matrix — deterministic replay on the Keystone mock app", () => {
  for (const scenario of SCENARIOS) {
    const name = `${scenario.id} ${scenario.title} → ${scenario.expected.status}`;
    const run = scenario.knownGap ? it.fails : it;

    run(
      scenario.knownGap ? `${name} [known gap: ${scenario.knownGap}]` : name,
      async () => {
        const result = await replay(scenario);
        expect(result, `observed: ${JSON.stringify(result)}`).toMatchObject(scenario.expected);
      },
      SCENARIO_TIMEOUT_MS
    );
  }
});
