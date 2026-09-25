/**
 * Hand-written schema-v2 capability artifacts for the Keystone CU mock app —
 * the fixed inputs of the scenario matrix, so the matrix measures the replay
 * engine rather than the quality of one particular discovery run.
 *
 * Runtime conditions (not found, session expired, notices...) are not
 * repeated here: they live in profiles/keystone-cu.json.
 */

import { ARTIFACT_SCHEMA_VERSION, type AllowlistConfig, type CapabilityArtifact } from "../artifact/types.js";

const allowlist: AllowlistConfig = {
  permittedDomains: ["localhost", "127.0.0.1"],
  permittedUrlPatterns: ["/*"],
  permittedActions: ["navigate", "click", "type", "select", "extract", "submit"],
  irreversibleActions: ["submit"],
};

function base(baseUrl: string): Pick<CapabilityArtifact, "schemaVersion" | "artifactVersion" | "surface" | "allowlist" | "metadata"> {
  return {
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    artifactVersion: 1,
    surface: { type: "web", baseUrl, app: "keystone-cu" },
    allowlist,
    metadata: { recordedAt: "2026-09-24T00:00:00Z", recordedBy: "scenario-fixture" },
  };
}

/** Search a member, open their detail page, read the savings balance. */
export function lookupSavingsBalance(baseUrl: string): CapabilityArtifact {
  return {
    ...base(baseUrl),
    capability: "lookup-savings-balance",
    description: "Look up a member by ID and read their savings balance",
    params: [{ name: "memberId", type: "string", required: true }],
    outputs: [{ name: "savingsBalance", type: "string" }],
    steps: [
      {
        id: 1,
        action: "navigate",
        value: `${baseUrl}/search`,
        checkpoint: { anyOf: [{ axContains: [{ role: "textbox", name: "Member ID" }] }] },
      },
      { id: 2, action: "type", target: { role: "textbox", name: "Member ID" }, value: "{{memberId}}" },
      {
        id: 3,
        action: "click",
        target: { role: "button", name: "Search" },
        checkpoint: { anyOf: [{ axContains: [{ role: "link", name: "{{memberId}}" }] }] },
      },
      {
        id: 4,
        action: "click",
        target: { role: "link", name: "{{memberId}}" },
        checkpoint: { anyOf: [{ urlPattern: "/detail?id={{memberId}}", textContains: "Member Detail" }] },
      },
      {
        id: 5,
        action: "extract",
        target: { role: "cell", row: "Savings", column: "Balance" },
        output: "savingsBalance",
      },
    ],
    checkpoint: { outputsExtracted: true },
  };
}

/** Open a new sub-account for a member and reach the confirmation screen. */
export function openSubAccount(baseUrl: string): CapabilityArtifact {
  return {
    ...base(baseUrl),
    capability: "open-sub-account",
    description: "Open a new sub-account for a member and return the new account number",
    params: [
      { name: "memberId", type: "string", required: true },
      { name: "accountType", type: "string", required: true, description: "Savings, Checking or Certificate of Deposit" },
      { name: "deposit", type: "string", required: true },
    ],
    outputs: [{ name: "accountNumber", type: "string" }],
    steps: [
      {
        id: 1,
        action: "navigate",
        value: `${baseUrl}/new-account?id={{memberId}}`,
        checkpoint: { anyOf: [{ axContains: [{ role: "textbox", name: "Initial Deposit" }] }] },
      },
      { id: 2, action: "select", target: { role: "combobox", name: "Account Type" }, value: "{{accountType}}" },
      { id: 3, action: "type", target: { role: "textbox", name: "Initial Deposit" }, value: "{{deposit}}" },
      {
        id: 4,
        action: "submit",
        target: { role: "button", name: "Continue" },
        classification: "irreversible",
        checkpoint: { anyOf: [{ textContains: "Sub-Account Opened Successfully" }] },
      },
      { id: 5, action: "extract", target: { role: "cell", label: "Account Number" }, output: "accountNumber" },
    ],
    checkpoint: { outputsExtracted: true },
  };
}

/**
 * Open the account of a given type from the member detail table. Every row
 * has an identical "Manage" link, so the param decides WHICH element to click
 * — the case that broke the Goodreads genre replay.
 */
export function manageAccountByType(baseUrl: string): CapabilityArtifact {
  return {
    ...base(baseUrl),
    capability: "manage-account-by-type",
    description: "Open the account of the given type and read its current balance",
    params: [
      { name: "memberId", type: "string", required: true },
      { name: "accountType", type: "string", required: true },
    ],
    outputs: [{ name: "balance", type: "string" }],
    steps: [
      {
        id: 1,
        action: "navigate",
        value: `${baseUrl}/detail?id={{memberId}}`,
        checkpoint: { anyOf: [{ textContains: "Member Detail" }] },
      },
      {
        id: 2,
        action: "click",
        target: { role: "link", name: "Manage", row: "{{accountType}}" },
        checkpoint: { anyOf: [{ urlPattern: "/account-action?id={{memberId}}", textContains: "Account Maintenance" }] },
      },
      { id: 3, action: "extract", target: { role: "cell", label: "Current Balance" }, output: "balance" },
    ],
    checkpoint: { outputsExtracted: true },
  };
}
