/**
 * Hand-written capability artifacts for the Keystone CU mock app, shaped the
 * way the recorder emits them: role + name locators, literal values captured
 * during a discovery run for member 12345, {{param}} templates for inputs.
 *
 * They are the fixed inputs of the scenario matrix, so the matrix measures
 * the replay engine rather than the quality of one particular discovery run.
 */

import type { AllowlistConfig, CapabilityArtifact, ErrorHandler, ArtifactStep } from "../artifact/types.js";

const allowlist: AllowlistConfig = {
  permittedDomains: ["localhost", "127.0.0.1"],
  permittedUrlPatterns: ["/*"],
  permittedActions: ["navigate", "click", "type", "extract", "submit"],
  irreversibleActions: ["submit"],
};

/**
 * Runtime conditions every Keystone screen can show. Today they must be
 * repeated on each step; Phase 1 moves them into a shared app profile.
 */
const KEYSTONE_ERROR_HANDLERS: ErrorHandler[] = [
  {
    when: { anyOf: [{ textContains: "No records found" }, { textContains: "Member not found" }] },
    handler: "fail",
    outcome: "not-found",
    description: "Member does not exist",
  },
  {
    when: { anyOf: [{ textContains: "Validation Error" }] },
    handler: "fail",
    outcome: "validation-error",
    description: "Form rejected the input",
  },
  {
    when: { anyOf: [{ textContains: "Access Denied" }] },
    handler: "fail",
    outcome: "permission-denied",
    description: "Operator lacks permission for this member",
  },
  {
    when: { anyOf: [{ textContains: "Session Expired" }] },
    handler: "escalate",
    description: "Session expired — a human must re-authenticate",
  },
  {
    when: { anyOf: [{ textContains: "Service Temporarily Unavailable" }] },
    handler: "retry",
    maxRetries: 2,
    description: "Transient server error",
  },
];

/** The maintenance notice is a known interstitial: dismiss it and carry on. */
export const DISMISS_NOTICE_HANDLER: ErrorHandler = {
  when: { anyOf: [{ axContains: [{ role: "button", name: "Acknowledge" }] }] },
  handler: "dismiss",
  maxRetries: 1,
  description: "Known system notice overlay",
};

interface BuildOptions {
  extraHandlers?: ErrorHandler[];
}

function withHandlers(steps: Omit<ArtifactStep, "onError">[], opts: BuildOptions): ArtifactStep[] {
  const onError = [...(opts.extraHandlers ?? []), ...KEYSTONE_ERROR_HANDLERS];
  return steps.map((step) => ({ ...step, onError }));
}

function metadata(): CapabilityArtifact["metadata"] {
  return { recordedAt: "2026-09-24T00:00:00Z", recordedBy: "scenario-fixture" };
}

/** Search a member, open their detail page, read the savings balance. */
export function lookupSavingsBalance(baseUrl: string, opts: BuildOptions = {}): CapabilityArtifact {
  return {
    schemaVersion: "1.0",
    artifactVersion: 1,
    capability: "lookup-savings-balance",
    description: "Look up a member by ID and read their savings balance",
    surface: { type: "web", baseUrl },
    params: [{ name: "memberId", type: "string", required: true }],
    outputs: [{ name: "savingsBalance", type: "string" }],
    allowlist,
    steps: withHandlers(
      [
        { id: 1, action: "navigate", target: { primary: { role: "RootWebArea", name: "search" } }, value: `${baseUrl}/search` },
        { id: 2, action: "type", target: { primary: { role: "textbox", name: "Member ID" } }, value: "{{memberId}}" },
        { id: 3, action: "click", target: { primary: { role: "button", name: "Search" } } },
        { id: 4, action: "click", target: { primary: { role: "link", name: "{{memberId}}" } } },
        // Recorded literally from member 12345's savings row
        { id: 5, action: "extract", target: { primary: { role: "cell", name: "$12,847.00" } }, output: "savingsBalance" },
      ],
      opts
    ),
    checkpoint: { outputsExtracted: true },
    metadata: metadata(),
  };
}

/** Open a new sub-account for a member and reach the confirmation screen. */
export function openSubAccount(baseUrl: string, opts: BuildOptions = {}): CapabilityArtifact {
  return {
    schemaVersion: "1.0",
    artifactVersion: 1,
    capability: "open-sub-account",
    description: "Open a new savings sub-account and reach the confirmation screen",
    surface: { type: "web", baseUrl },
    params: [
      { name: "memberId", type: "string", required: true },
      { name: "deposit", type: "string", required: true },
    ],
    outputs: [{ name: "confirmation", type: "string" }],
    allowlist,
    steps: withHandlers(
      [
        { id: 1, action: "navigate", target: { primary: { role: "RootWebArea", name: "new-account" } }, value: `${baseUrl}/new-account?id={{memberId}}` },
        { id: 2, action: "type", target: { primary: { role: "textbox", name: "Initial Deposit" } }, value: "{{deposit}}" },
        { id: 3, action: "submit", target: { primary: { role: "button", name: "Continue" } }, classification: "irreversible" },
        { id: 4, action: "extract", target: { primary: { role: "heading", name: "Sub-Account Opened Successfully" } }, output: "confirmation" },
      ],
      opts
    ),
    checkpoint: { outputsExtracted: true },
    metadata: metadata(),
  };
}

/**
 * Open the account of a given type from the member detail table. Every row
 * has an identical "Manage" link, so the param decides WHICH element to
 * click — the case that broke the Goodreads genre replay.
 */
export function manageAccountByType(baseUrl: string, opts: BuildOptions = {}): CapabilityArtifact {
  return {
    schemaVersion: "1.0",
    artifactVersion: 1,
    capability: "manage-account-by-type",
    description: "Open the account of the given type and read its current balance",
    surface: { type: "web", baseUrl },
    params: [
      { name: "memberId", type: "string", required: true },
      { name: "accountType", type: "string", required: true },
    ],
    outputs: [{ name: "balance", type: "string" }],
    allowlist,
    steps: withHandlers(
      [
        { id: 1, action: "navigate", target: { primary: { role: "RootWebArea", name: "detail" } }, value: `${baseUrl}/detail?id={{memberId}}` },
        // Recorded on member 12345 with accountType=Savings (second row)
        { id: 2, action: "click", target: { primary: { role: "link", name: "Manage" } } },
        { id: 3, action: "extract", target: { primary: { role: "cell", name: "$12,847.00" } }, output: "balance" },
      ],
      opts
    ),
    checkpoint: { outputsExtracted: true },
    metadata: metadata(),
  };
}
