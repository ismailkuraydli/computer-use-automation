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
import type { AppProfile } from "../artifact/profile-types.js";
import { loadProfile } from "../artifact/profile-store.js";
import { lookupSavingsBalance, openSubAccount, manageAccountByType } from "./mock-app-artifacts.js";
import { EscalationManager } from "../escalation/escalation-manager.js";
import type { OperatorChannel } from "../escalation/operator-channel.js";
import type { Surface } from "../surface/types.js";
import { applyTenantOverlay, loadTenantOverlay, type TenantOverlay } from "../artifact/tenant-overlay.js";
import { resolveWorkspace } from "../app/workspace.js";

type ExpectedResult =
  | { status: "success"; outputs: Record<string, unknown>; humanActions?: unknown[] }
  | { status: "business-outcome"; outcome: string }
  | { status: "escalated"; resolution?: string }
  | { status: "failure"; stepId?: number; error?: string };

interface Scenario {
  id: string;
  title: string;
  artifact: (baseUrl: string) => CapabilityArtifact;
  params: Record<string, string>;
  faults?: MockFaults;
  /** Adjust the Keystone profile, e.g. to make an interstitial unknown. */
  profile?: (profile: AppProfile) => AppProfile;
  /** A scripted operator who takes over the live session on escalation. */
  operator?: (surface: Surface) => OperatorChannel;
  /**
   * Replay on the Summit tenant (same product, configured differently):
   * "host-only" just points the artifact at Summit, "overlay" applies
   * profiles/tenants/keystone-cu/summit.json.
   */
  tenant?: "host-only" | "overlay";
  /** The caller confirms irreversible steps may run. */
  confirmIrreversible?: boolean;
  expected: ExpectedResult;
  /** Why the current engine fails this row. Remove once fixed. */
  knownGap?: string;
}

const SCENARIO_TIMEOUT_MS = 90_000;

const KEYSTONE_PROFILE = loadProfile("keystone-cu");
const SUMMIT_OVERLAY = loadTenantOverlay(resolveWorkspace(), "keystone-cu", "summit");
const withoutInterstitials = (profile: AppProfile): AppProfile => ({ ...profile, interstitials: [] });
const ACCOUNT_NUMBER = expect.stringMatching(/^\d{10}$/);

/** Stands in for a person: closes the unknown overlay in the live page, then says "done". */
const closesOverlay = (surface: Surface): OperatorChannel => ({
  async requestIntervention() {
    await surface.act({ type: "click", target: { role: "button", name: "Acknowledge" } });
    return "done";
  },
});

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
  },
  {
    id: "L6",
    title: "known notice overlay blocks the results page",
    artifact: lookupSavingsBalance,
    params: { memberId: "12345" },
    faults: { interstitialPaths: ["/search"] },
    expected: { status: "success", outputs: { savingsBalance: "$12,847.00" } },
  },
  {
    id: "L7",
    title: "unknown overlay blocks the results page",
    artifact: lookupSavingsBalance,
    params: { memberId: "12345" },
    faults: { interstitialPaths: ["/search"] },
    profile: withoutInterstitials,
    expected: { status: "escalated" },
  },
  {
    id: "L7h",
    title: "unknown overlay (on every results load), operator clears it in the live session each time",
    artifact: lookupSavingsBalance,
    params: { memberId: "12345" },
    faults: { interstitialPaths: ["/search"] },
    profile: withoutInterstitials,
    operator: closesOverlay,
    expected: {
      status: "success",
      outputs: { savingsBalance: "$12,847.00" },
      humanActions: [
        { action: "click", target: 'button "Acknowledge"' },
        { action: "click", target: 'button "Acknowledge"' },
      ],
    },
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
    params: { memberId: "12345", accountType: "Checking", deposit: "500" },
    confirmIrreversible: true,
    expected: { status: "success", outputs: { accountNumber: ACCOUNT_NUMBER } },
  },
  {
    id: "A2",
    title: "validation error on bad deposit",
    artifact: openSubAccount,
    params: { memberId: "12345", accountType: "Savings", deposit: "abc" },
    confirmIrreversible: true,
    expected: { status: "business-outcome", outcome: "validation-error" },
  },
  {
    id: "A3",
    title: "permission denied for restricted member",
    artifact: openSubAccount,
    params: { memberId: "34567", accountType: "Savings", deposit: "500" },
    confirmIrreversible: true,
    expected: { status: "business-outcome", outcome: "permission-denied" },
  },
  {
    id: "A4",
    title: "unexpected confirm() dialog on an irreversible submit",
    artifact: openSubAccount,
    params: { memberId: "12345", accountType: "Savings", deposit: "500" },
    faults: { confirmOnSubmit: true },
    confirmIrreversible: true,
    expected: { status: "escalated" },
  },
  {
    id: "A5",
    title: "irreversible submit without caller confirmation",
    artifact: openSubAccount,
    params: { memberId: "12345", accountType: "Savings", deposit: "500" },
    expected: { status: "escalated" },
  },

  // --- manage-account-by-type ---
  {
    id: "M1",
    title: "param selects the row (Savings is not the first row)",
    artifact: manageAccountByType,
    params: { memberId: "12345", accountType: "Savings" },
    expected: { status: "success", outputs: { balance: "$12,847.00" } },
  },
  {
    id: "M2",
    title: "param selects the row, different member",
    artifact: manageAccountByType,
    params: { memberId: "45678", accountType: "Checking" },
    expected: { status: "success", outputs: { balance: "$2,340.00" } },
  },

  // --- the same artifacts on a second tenant (cross-tenant reuse) ---
  {
    id: "T1",
    title: "Keystone artifact pointed at Summit without its overlay (drift is reported precisely)",
    artifact: lookupSavingsBalance,
    params: { memberId: "23456" },
    tenant: "host-only",
    expected: { status: "failure", stepId: 1, error: "checkpoint-failed" },
  },
  {
    id: "T2",
    title: "Keystone artifact on Summit with the tenant overlay",
    artifact: lookupSavingsBalance,
    params: { memberId: "23456" },
    tenant: "overlay",
    expected: { status: "success", outputs: { savingsBalance: "$8,234.50" } },
  },
  {
    id: "T3",
    title: "row-selecting artifact on Summit with the tenant overlay",
    artifact: manageAccountByType,
    params: { memberId: "45678", accountType: "Checking" },
    tenant: "overlay",
    expected: { status: "success", outputs: { balance: "$2,340.00" } },
  },
];

let mock: MockApp;
let server: Server;
let baseUrl: string;
let summitServer: Server;
let summitUrl: string;
let evidenceRoot: string;

function listen(app: MockApp["app"]): Promise<Server> {
  return new Promise<Server>((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
}

beforeAll(async () => {
  mock = createMockApp();
  server = await listen(mock.app);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  summitServer = await listen(createMockApp({ variant: "summit" }).app);
  summitUrl = `http://127.0.0.1:${(summitServer.address() as AddressInfo).port}`;
  evidenceRoot = mkdtempSync(path.join(tmpdir(), "scenario-matrix-"));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await new Promise<void>((resolve) => summitServer.close(() => resolve()));
  rmSync(evidenceRoot, { recursive: true, force: true });
});

afterEach(() => mock.resetFaults());

async function replay(scenario: Scenario): Promise<ReplayResult> {
  mock.setFaults(scenario.faults ?? {});
  const evidence = new EvidenceCollector(evidenceRoot);
  const surface = new PlaywrightSurface({ headless: true, screenshotDir: evidence.screenshotDir });
  await surface._start();
  try {
    let profile = (scenario.profile ?? ((p) => p))(KEYSTONE_PROFILE);
    let artifact = scenario.artifact(baseUrl); // always recorded on Keystone
    if (scenario.tenant) {
      const overlay: TenantOverlay =
        scenario.tenant === "overlay"
          ? { ...SUMMIT_OVERLAY, baseUrl: summitUrl }
          : { schemaVersion: "1.0", app: "keystone-cu", tenant: "host-only", baseUrl: summitUrl };
      ({ artifact, profile } = applyTenantOverlay(artifact, profile, overlay));
    }
    const handoff = scenario.operator ? new EscalationManager(surface, evidence, scenario.operator(surface)) : undefined;
    const engine = new ReplayEngine({ surface, evidenceCollector: evidence, profile, handoff });
    return await engine.run(artifact, scenario.params, {
      confirmIrreversible: scenario.confirmIrreversible,
    });
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
