/**
 * Acts as an agent host: starts bin/cua-mcp over stdio exactly as Claude Code
 * or Codex would, lists the tools and capabilities, and runs one capability.
 *
 * Usage: npx tsx scripts/mcp-demo.ts <capability> '<params json>' [tenant]
 * The workspace is CUA_WORKSPACE (default: the repo root).
 */

import path from "path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PACKAGE_ROOT } from "../src/app/workspace.js";

async function main(): Promise<void> {
  const [name, paramsJson = "{}", tenant] = process.argv.slice(2);
  if (!name) throw new Error("usage: mcp-demo.ts <capability> '<params json>' [tenant]");

  const transport = new StdioClientTransport({
    command: path.join(PACKAGE_ROOT, "bin/cua-mcp"),
    env: { ...(process.env as Record<string, string>), CUA_WORKSPACE: process.env.CUA_WORKSPACE ?? PACKAGE_ROOT },
    stderr: "inherit",
  });
  const client = new Client({ name: "mcp-demo", version: "1.0.0" });
  await client.connect(transport);

  try {
    const { tools } = await client.listTools();
    console.log(`tools: ${tools.map((t) => t.name).join(", ")}`);

    const listed = await client.callTool({ name: "list_capabilities", arguments: {} });
    const catalog = JSON.parse((listed.content as Array<{ text: string }>)[0].text);
    for (const c of catalog.capabilities) {
      console.log(`capability: ${c.name} v${c.version} params=${JSON.stringify(c.params.properties)} irreversible=${c.irreversible}`);
    }

    const args = { name, params: JSON.parse(paramsJson), ...(tenant ? { tenant } : {}) };
    console.log(`\ncall run_capability ${JSON.stringify(args)}`);
    const run = await client.callTool({ name: "run_capability", arguments: args });
    console.log((run.content as Array<{ text: string }>)[0].text);
  } finally {
    await client.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
