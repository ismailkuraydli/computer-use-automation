import { describe, it, expect } from "vitest";
import { Recorder } from "./recorder.js";
import type { Action, ScreenState, AXNode } from "../surface/types.js";
import type { AllowlistConfig } from "../artifact/types.js";

const allowlist: AllowlistConfig = {
  permittedDomains: ["localhost"],
  permittedUrlPatterns: ["/*"],
  permittedActions: ["navigate", "click", "type", "extract", "submit"],
  irreversibleActions: ["submit"],
};

function screen(url: string, axTree: AXNode[] = []): ScreenState {
  return { url, title: "Keystone", axTree, domSnapshot: "", frameUrls: [url] };
}

const SEARCH = screen("http://localhost:3000/search", [
  { role: "textbox", name: "Member ID" },
  { role: "button", name: "Search" },
]);

const DETAIL = screen("http://localhost:3000/detail?id=12345", [
  { role: "heading", name: "Member Detail - John A. Smith" },
  { role: "columnheader", name: "Balance" },
  { role: "cell", name: "$4,521.33", context: { row: ["Checking", "1002003004", "$4,521.33", "Manage"], column: "Balance" } },
  { role: "cell", name: "$12,847.00", context: { row: ["Savings", "2003004005", "$12,847.00", "Manage"], column: "Balance" } },
  { role: "link", name: "Manage", context: { row: ["Checking", "1002003004", "$4,521.33", "Manage"], column: "Action" } },
  { role: "link", name: "Manage", context: { row: ["Savings", "2003004005", "$12,847.00", "Manage"], column: "Action" } },
]);

const ACCOUNT = screen("http://localhost:3000/account-action?id=12345&acct=2003004005", [
  { role: "cell", name: "$12,847.00", context: { row: ["Current Balance", "$12,847.00"], column: "Value", label: "Current Balance" } },
]);

function recorder(paramValues: Record<string, string> = {}): Recorder {
  return new Recorder({
    capability: "lookup",
    description: "Look up a member",
    allowlist,
    params: [
      { name: "memberId", type: "string", required: true },
      { name: "accountType", type: "string", required: true },
    ],
    outputs: [{ name: "balance", type: "string" }],
    paramValues,
    app: "keystone-cu",
  });
}

function finalize(r: Recorder) {
  return r.finalize([], [{ name: "balance", type: "string" }], { outputsExtracted: true });
}

describe("Recorder", () => {
  it("emits a schema-v2 artifact with the app profile and base URL", () => {
    const r = recorder();
    r.recordAction({ type: "navigate", value: "http://localhost:3000/search" }, screen("about:blank"), SEARCH, "success");

    const artifact = finalize(r);

    expect(artifact.schemaVersion).toBe("2.0");
    expect(artifact.surface).toEqual({ type: "web", baseUrl: "http://localhost:3000", app: "keystone-cu" });
    expect(artifact.steps[0]).toMatchObject({ id: 1, action: "navigate", value: "http://localhost:3000/search" });
    expect(artifact.steps[0].target).toBeUndefined();
  });

  it("does not record failed actions", () => {
    const r = recorder();
    r.recordAction({ type: "click", target: { role: "button", name: "Missing" } }, SEARCH, SEARCH, "failure");

    expect(finalize(r).steps).toHaveLength(0);
  });

  it("turns an extracted table value into a row + column target", () => {
    const r = recorder({ accountType: "Savings" });
    r.recordAction({ type: "extract", target: { role: "cell", name: "$12,847.00" }, output: "balance" }, DETAIL, DETAIL, "success");

    expect(finalize(r).steps[0].target).toEqual({ role: "cell", row: "{{accountType}}", column: "Balance" });
  });

  it("turns a value in a key/value table into a label target", () => {
    const r = recorder();
    r.recordAction({ type: "extract", target: { role: "cell", name: "$12,847.00" }, output: "balance" }, ACCOUNT, ACCOUNT, "success");

    expect(finalize(r).steps[0].target).toEqual({ role: "cell", label: "Current Balance" });
  });

  it("scopes a control that repeats on every row to the row the model chose", () => {
    const r = recorder({ memberId: "12345", accountType: "Savings" });
    const click: Action = { type: "click", target: { role: "link", name: "Manage", row: "Savings" } };
    r.recordAction(click, DETAIL, ACCOUNT, "success");

    const step = finalize(r).steps[0];
    expect(step.target).toEqual({ role: "link", name: "Manage", row: "{{accountType}}" });
    expect(step.checkpoint).toEqual({ anyOf: [{ urlPattern: "/account-action?id={{memberId}}&acct=*" }] });
  });

  it("adds a row scope itself when the model did not", () => {
    const r = recorder();
    r.recordAction({ type: "click", target: { role: "link", name: "Manage" } }, DETAIL, ACCOUNT, "success");

    expect(finalize(r).steps[0].target).toEqual({ role: "link", name: "Manage", row: "Checking" });
  });

  it("uses the model's expectation as the checkpoint text", () => {
    const r = recorder();
    r.recordAction({ type: "click", target: { role: "button", name: "Search" } }, SEARCH, DETAIL, "success", "Member Detail");

    expect(finalize(r).steps[0].checkpoint?.anyOf?.[0].textContains).toBe("Member Detail");
  });

  it("falls back to static controls and headers that appeared, skipping data", () => {
    const r = recorder();
    r.recordAction({ type: "click", target: { role: "button", name: "Search" } }, SEARCH, DETAIL, "success");

    const sig = finalize(r).steps[0].checkpoint?.anyOf?.[0];
    expect(sig?.axContains).toEqual([{ role: "columnheader", name: "Balance" }]);
  });

  it("parameterizes typed values, URLs and target names", () => {
    const r = recorder({ memberId: "12345" });
    r.recordAction({ type: "type", target: { role: "textbox", name: "Member ID" }, value: "12345" }, SEARCH, SEARCH, "success");
    r.recordAction({ type: "navigate", value: "http://localhost:3000/detail?id=12345" }, SEARCH, DETAIL, "success");

    const [type, nav] = finalize(r).steps;
    expect(type.value).toBe("{{memberId}}");
    expect(nav.value).toBe("http://localhost:3000/detail?id={{memberId}}");
    expect(nav.checkpoint?.anyOf?.[0].urlPattern).toBe("/detail?id={{memberId}}");
  });

  it("infers a param value typed from the goal", () => {
    const r = new Recorder({
      capability: "lookup",
      description: "Look up",
      allowlist,
      params: [{ name: "memberId", type: "string", required: true }],
      goal: "Look up member 12345",
    });
    r.recordAction({ type: "type", target: { role: "textbox", name: "Member ID" }, value: "12345" }, SEARCH, SEARCH, "success");

    expect(r.discoveryParams).toEqual({ memberId: "12345" });
    expect(finalize(r).steps[0].value).toBe("{{memberId}}");
  });

  it("classifies irreversible actions from the allowlist", () => {
    const r = recorder();
    r.recordAction({ type: "submit", target: { role: "button", name: "Continue" } }, SEARCH, DETAIL, "success");

    expect(finalize(r).steps[0].classification).toBe("irreversible");
  });

  it("keeps the frame of a target", () => {
    const r = recorder();
    r.recordAction({ type: "click", target: { role: "link", name: "Member Search", frame: ["navFrame"] } }, SEARCH, SEARCH, "success");

    expect(finalize(r).steps[0].target).toEqual({ role: "link", name: "Member Search", frame: ["navFrame"] });
  });
});
