/**
 * The repo root is a plugin for both Claude Code and Codex. These checks
 * keep the manifests parseable, consistent with package.json, and pointing
 * at files that exist.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, statSync } from "fs";
import path from "path";
import { PACKAGE_ROOT } from "../app/workspace.js";

const read = (relative: string) => JSON.parse(readFileSync(path.join(PACKAGE_ROOT, relative), "utf-8"));
const pkg = read("package.json");
const PLUGIN = "computer-use-automation";

describe("Claude Code plugin", () => {
  const manifest = read(".claude-plugin/plugin.json");
  const marketplace = read(".claude-plugin/marketplace.json");

  it("names the plugin and matches the package version", () => {
    expect(manifest.name).toBe(PLUGIN);
    expect(manifest.version).toBe(pkg.version);
  });

  it("launches the MCP server through the bundled launcher and passes the API key from user config", () => {
    const server = manifest.mcpServers[PLUGIN];
    expect(server.command).toBe("${CLAUDE_PLUGIN_ROOT}/bin/cua-mcp");
    expect(server.env.OPENROUTER_API_KEY).toBe("${user_config.openrouter_api_key}");
    expect(server.env.CUA_TARGET_URL).toBe("${user_config.target_url}");
    expect(manifest.userConfig.target_url.sensitive).toBe(false);
    expect(manifest.userConfig.openrouter_api_key.sensitive).toBe(true);
  });

  it("is listed by a marketplace at the repo root", () => {
    expect(marketplace.plugins).toEqual([expect.objectContaining({ name: PLUGIN, source: "./" })]);
  });
});

describe("Codex plugin", () => {
  const manifest = read(".codex-plugin/plugin.json");
  const marketplace = read(".agents/plugins/marketplace.json");

  it("names the plugin, matches the package version and points at existing files", () => {
    expect(manifest.name).toBe(PLUGIN);
    expect(manifest.version).toBe(pkg.version);
    expect(existsSync(path.join(PACKAGE_ROOT, manifest.mcpServers))).toBe(true);
    expect(existsSync(path.join(PACKAGE_ROOT, manifest.skills))).toBe(true);
  });

  it("starts the launcher from the plugin root with a timeout long enough for discovery", () => {
    const server = read(manifest.mcpServers).mcpServers[PLUGIN];
    expect(server).toMatchObject({ command: "./bin/cua-mcp", cwd: "." });
    expect(server.env_vars).toEqual(expect.arrayContaining(["OPENROUTER_API_KEY", "CUA_TARGET_URL", "CUA_WORKSPACE"]));
    expect(server.tool_timeout_sec).toBeGreaterThanOrEqual(300);
  });

  it("is listed by a marketplace at the repo root", () => {
    expect(marketplace.plugins).toEqual([
      expect.objectContaining({ name: PLUGIN, source: { source: "local", path: "./" } }),
    ]);
  });
});

describe("shared pieces", () => {
  it("ships an executable launcher and the agent skill", () => {
    const launcher = path.join(PACKAGE_ROOT, "bin/cua-mcp");
    expect(statSync(launcher).mode & 0o111).not.toBe(0);
    expect(readFileSync(path.join(PACKAGE_ROOT, "skills/computer-use-automation/SKILL.md"), "utf-8")).toMatch(/^---\nname: /);
  });

  it("keeps the runtime dependencies the launcher needs out of devDependencies", () => {
    expect(Object.keys(pkg.dependencies)).toEqual(expect.arrayContaining(["tsx", "@modelcontextprotocol/sdk", "playwright"]));
  });
});
