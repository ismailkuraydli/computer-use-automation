#!/usr/bin/env node
/**
 * MCP server (stdio) — the entry point that Claude Code and Codex plugins
 * launch via bin/cua-mcp. Data lives in CUA_WORKSPACE (default: cwd).
 */

import "./stdio-guard.js"; // must stay first: keeps stdout for the protocol
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createCuaServer } from "./tools.js";
import { resolveWorkspace } from "../app/workspace.js";

async function main(): Promise<void> {
  const workspace = resolveWorkspace();
  const server = createCuaServer({ workspace });
  await server.connect(new StdioServerTransport());
  console.error(`computer-use-automation MCP server ready (workspace: ${workspace.root})`);
}

main().catch((e) => {
  console.error("MCP server failed to start:", e);
  process.exit(1);
});
