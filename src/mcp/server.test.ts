/**
 * The MCP surface end to end: a real MCP client talks to the server over an
 * in-memory transport; capabilities replay against an in-process mock app.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCuaServer } from "./tools.js";
import { createMockApp } from "../../mock-app/app.js";
import { lookupSavingsBalance, openSubAccount } from "../scenarios/mock-app-artifacts.js";
import { MockLLMClient } from "../llm/mock-client.js";
import { resolveWorkspace } from "../app/workspace.js";

const TIMEOUT_MS = 120_000;

let server: Server;
let baseUrl: string;
let root: string;
let client: Client;

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>)[0].text;
  return { isError: result.isError === true, body: JSON.parse(text) };
}

beforeAll(async () => {
  const mock = createMockApp();
  server = await new Promise<Server>((resolve) => {
    const s = mock.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  root = mkdtempSync(path.join(tmpdir(), "cua-mcp-"));
  for (const artifact of [lookupSavingsBalance(baseUrl), openSubAccount(baseUrl)]) {
    mkdirSync(path.join(root, "artifacts", artifact.capability), { recursive: true });
    writeFileSync(path.join(root, "artifacts", artifact.capability, "v1.json"), JSON.stringify(artifact));
  }

  const mcp = createCuaServer({
    workspace: resolveWorkspace({ CUA_WORKSPACE: root }),
    discovery: {
      llm: () =>
        new MockLLMClient({
          plan: {
            capability: "read-member-heading",
            description: "Open a member's detail page",
            params: [{ name: "memberId", type: "string", required: true }],
            outputs: [{ name: "result", type: "string" }],
            subGoals: [],
            paramValues: { memberId: "12345" },
          },
          script: [
            { action: { type: "navigate", value: `${baseUrl}/detail?id=12345` }, reasoning: "open", goalMet: false },
            { action: { type: "extract", target: { role: "cell", name: "$12,847.00" }, output: "result" }, reasoning: "read", goalMet: true },
          ],
        }),
    },
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-agent", version: "1.0.0" });
  await Promise.all([mcp.connect(serverSide), client.connect(clientSide)]);
});

afterAll(async () => {
  await client.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(root, { recursive: true, force: true });
});

describe("MCP capability catalog", () => {
  it("offers list, run and discover tools", async () => {
    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name).sort()).toEqual(["discover_capability", "list_capabilities", "run_capability"]);
  });

  it("lists saved capabilities with typed params and outputs (AC1)", async () => {
    const { body } = await call("list_capabilities");

    expect(body.capabilities).toEqual([
      expect.objectContaining({
        name: "lookup-savings-balance",
        params: expect.objectContaining({ properties: { memberId: { type: "string" } }, required: ["memberId"] }),
        outputs: [{ name: "savingsBalance", type: "string" }],
        irreversible: false,
      }),
      expect.objectContaining({ name: "open-sub-account", irreversible: true }),
    ]);
  });

  it(
    "runs a capability by name with typed params and returns the ReplayResult (AC2)",
    async () => {
      const { isError, body } = await call("run_capability", { name: "lookup-savings-balance", params: { memberId: "23456" } });

      expect(isError).toBe(false);
      expect(body).toMatchObject({ status: "success", outputs: { savingsBalance: "$8,234.50" }, version: 1 });
      expect(body.evidencePath).toMatch(/^evidence\//);
    },
    TIMEOUT_MS
  );

  it(
    "returns business outcomes and escalations as results, not errors",
    async () => {
      const notFound = await call("run_capability", { name: "lookup-savings-balance", params: { memberId: "99999" } });
      const unconfirmed = await call("run_capability", {
        name: "open-sub-account",
        params: { memberId: "12345", accountType: "Savings", deposit: "10" },
      });

      expect(notFound.body).toMatchObject({ status: "business-outcome", outcome: "not-found" });
      expect(unconfirmed.body).toMatchObject({ status: "escalated", stepId: 4 });
    },
    TIMEOUT_MS
  );

  it("rejects unknown capabilities and badly typed params before touching a browser", async () => {
    const unknown = await call("run_capability", { name: "wire-money", params: {} });
    const badParams = await call("run_capability", { name: "lookup-savings-balance", params: { memberId: 12345, extra: "x" } });

    expect(unknown).toMatchObject({ isError: true, body: { available: ["lookup-savings-balance", "open-sub-account"] } });
    expect(badParams.isError).toBe(true);
    expect(badParams.body.problems).toEqual(['param "memberId" must be a string', 'unknown param "extra" (expected: memberId)']);
  });

  it("accepts only bare names for app and allowlist, never file paths", async () => {
    // A perfectly valid allowlist, but outside the workspace: must not be read
    const outside = path.join(mkdtempSync(path.join(tmpdir(), "outside-")), "allow.json");
    writeFileSync(outside, JSON.stringify({ permittedDomains: ["127.0.0.1"], permittedUrlPatterns: ["/*"], permittedActions: ["navigate"] }));
    const target = `${baseUrl}/search`;

    for (const args of [
      { goal: "x", target, allowlist: outside },
      { goal: "x", target, allowlist: path.relative(root, outside) },
      { goal: "x", target, app: "../profiles/keystone-cu" },
    ]) {
      const result = await client.callTool({ name: "discover_capability", arguments: args });
      // Rejected as input, before any discovery starts
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect((result.content as Array<{ text: string }>)[0].text).toMatch(/must be a name/);
    }
  });

  it(
    "discovers a new capability, self-checks it, and makes it runnable",
    async () => {
      const { isError, body } = await call("discover_capability", { goal: "Read member 12345's savings balance", target: `${baseUrl}/search` });

      expect(isError).toBe(false);
      expect(body).toMatchObject({ success: true, capability: "read-member-heading", artifactPath: "artifacts/read-member-heading/v1.json" });
      expect(body.selfCheck).toMatch(/^passed/);

      const run = await call("run_capability", { name: "read-member-heading", params: { memberId: "45678" } });
      expect(run.body).toMatchObject({ status: "success" });
    },
    TIMEOUT_MS
  );
});
