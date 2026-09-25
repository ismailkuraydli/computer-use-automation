/**
 * The capability catalog as MCP tools, for agents in Claude Code, Codex or
 * any MCP host:
 * - list_capabilities   what saved capabilities exist, their typed params/outputs
 * - run_capability      deterministic replay by name with typed params (no LLM)
 * - discover_capability LLM-driven discovery of a new capability from a goal
 *
 * Replay escalations (unknown popup, session expired, unconfirmed
 * irreversible step) come back as status "escalated" for the calling agent
 * to relay to its user; there is no interactive handoff over MCP.
 */

import path from "path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CapabilityCatalog, summarize } from "../catalog/capability-catalog.js";
import { replayCapability, ReplayRequestError, type ReplayRequest } from "../app/replay-service.js";
import { discoverCapability, DiscoveryRequestError, type DiscoveryRequest } from "../app/discovery-service.js";
import { resolveWorkspace, SAFE_NAME, type Workspace } from "../app/workspace.js";

/**
 * Profiles, tenants and allowlists are addressed by name only. The CLI may
 * pass file paths for local use; an MCP caller may not, so it cannot make
 * the server read files outside the workspace.
 */
const dataName = () => z.string().regex(SAFE_NAME, "must be a name (letters, digits, - or _), not a path");

export interface CuaServerOptions {
  workspace?: Workspace;
  /**
   * Where the application runs (plugin setting target_url, env
   * CUA_TARGET_URL). Replays are rebased onto it; discovery starts there.
   */
  targetUrl?: string;
  /** Overrides for tests (e.g. a scripted LLM for discovery). */
  discovery?: Partial<Pick<DiscoveryRequest, "llm" | "headed" | "configPath">>;
  replay?: Partial<Pick<ReplayRequest, "headed" | "configPath">>;
}

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };

const json = (value: unknown, isError = false): ToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  ...(isError ? { isError: true } : {}),
});

export function createCuaServer(opts: CuaServerOptions = {}): McpServer {
  const ws = opts.workspace ?? resolveWorkspace();
  const targetUrl = opts.targetUrl?.trim() || undefined;
  const targetError =
    targetUrl && !isHttpUrl(targetUrl) ? `Configured target_url "${targetUrl}" is not an http(s) URL` : undefined;
  const catalog = new CapabilityCatalog(ws.artifactsDir);
  const relative = (p: string) => path.relative(ws.root, p) || ".";

  const server = new McpServer({ name: "computer-use-automation", version: "0.2.0" });

  server.registerTool(
    "list_capabilities",
    {
      title: "List saved capabilities",
      description:
        "List the saved computer-use capabilities (recorded UI automations) with their JSON-Schema params, " +
        "outputs, version, and whether they contain irreversible steps. Call this before run_capability.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () =>
      targetError
        ? json({ error: targetError }, true)
        : json({ workspace: ws.root, targetUrl: targetUrl ?? null, capabilities: catalog.list() })
  );

  server.registerTool(
    "run_capability",
    {
      title: "Run a saved capability",
      description:
        "Replay a saved capability deterministically (no LLM) against its application and return a ReplayResult: " +
        "success with outputs, a business outcome (e.g. not-found), a failure with the step and what was expected vs " +
        "observed, or escalated (a human is needed — tell the user the reason). Params must match the capability's " +
        "schema from list_capabilities. Irreversible steps only run with confirmIrreversible: true — ask the user first.",
      inputSchema: {
        name: z.string().describe("Capability name from list_capabilities"),
        params: z.record(z.union([z.string(), z.number(), z.boolean()])).default({}).describe("Typed params"),
        version: z.number().int().positive().optional().describe("Artifact version; latest when omitted"),
        tenant: dataName().optional().describe("Tenant overlay name, for institutions running the same app configured differently"),
        confirmIrreversible: z.boolean().optional().describe("The user approved running irreversible steps"),
      },
      annotations: { destructiveHint: true, openWorldHint: true },
    },
    async ({ name, params, version, tenant, confirmIrreversible }) => {
      if (targetError) return json({ error: targetError }, true);
      const artifact = catalog.get(name, version);
      if (!artifact) {
        return json({ error: `No capability "${name}"${version ? ` v${version}` : ""}`, available: catalog.list().map((c) => c.name) }, true);
      }
      const problems = CapabilityCatalog.validateParams(artifact, params);
      if (problems.length > 0) return json({ error: "Invalid params", problems, expected: summarize(artifact).params }, true);

      try {
        const outcome = await replayCapability({
          artifact,
          params,
          tenant,
          baseUrl: targetUrl,
          confirmIrreversible,
          workspace: ws,
          ...opts.replay,
        });
        return json({ capability: name, version: artifact.artifactVersion, ...outcome.result, evidencePath: relative(outcome.evidenceDir) });
      } catch (e) {
        if (e instanceof ReplayRequestError) return json({ error: e.message }, true);
        throw e;
      }
    }
  );

  server.registerTool(
    "discover_capability",
    {
      title: "Discover a new capability",
      description:
        "Use the discovery LLM to accomplish a goal in a web application once, record it as a reusable capability, " +
        "and replay it as a self-check. Takes one to a few minutes and costs model tokens. Returns the new " +
        "capability's name, artifact path and self-check result; then call run_capability with other params.",
      inputSchema: {
        goal: z.string().min(1).describe('What to do, with example values, e.g. "Look up member 23456 and read their Savings balance"'),
        target: z
          .string()
          .optional()
          .describe("Page to start from: a full URL, or a path such as /search on the configured target_url; defaults to target_url"),
        app: dataName().optional().describe("App profile name (profiles/<app>.json), e.g. keystone-cu"),
        allowlist: dataName().optional().describe("Allowlist name (allowlists/<name>.json); defaults to the target's host"),
      },
      annotations: { openWorldHint: true },
    },
    async ({ goal, target, app, allowlist }) => {
      if (targetError) return json({ error: targetError }, true);
      const start = resolveStart(target, targetUrl);
      if (!start.ok) return json({ error: start.error }, true);
      try {
        const outcome = await discoverCapability({
          goal,
          target: start.url,
          app,
          allowlist,
          workspace: ws,
          log: (line) => console.error(line),
          ...opts.discovery,
        });
        return json(
          {
            success: outcome.success,
            reason: outcome.reason,
            capability: outcome.capability,
            stepsExecuted: outcome.stepsExecuted,
            outputs: outcome.outputs,
            selfCheck: outcome.selfCheck,
            artifactPath: outcome.artifactPath ? relative(outcome.artifactPath) : undefined,
            params: outcome.artifact ? summarize(outcome.artifact).params : undefined,
            evidencePath: relative(outcome.evidenceDir),
          },
          !outcome.success
        );
      } catch (e) {
        if (e instanceof DiscoveryRequestError) return json({ error: e.message }, true);
        throw e;
      }
    }
  );

  return server;
}

/** A full URL as-is; a path against the configured target URL; else that URL. */
function resolveStart(target: string | undefined, targetUrl: string | undefined): { ok: true; url: string } | { ok: false; error: string } {
  if (target && isHttpUrl(target)) return { ok: true, url: target };
  if (!targetUrl) {
    return {
      ok: false,
      error: target
        ? `"${target}" is not a full URL and no target_url is configured`
        : "No target given and no target_url configured (plugin setting target_url, or env CUA_TARGET_URL)",
    };
  }
  if (!target) return { ok: true, url: targetUrl };
  if (!target.startsWith("/")) return { ok: false, error: `target must be a full http(s) URL or a path starting with "/", got "${target}"` };
  return { ok: true, url: targetUrl.replace(/\/+$/, "") + target };
}

function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}
