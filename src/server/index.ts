/**
 * Local web UI server for the Computer-Use Automation System.
 * Provides a simple interface for discovery, artifact browsing, and replay
 * without needing to type CLI commands.
 *
 * Run: npm run ui
 * Open: http://localhost:3001
 */

import express from "express";
import { readdirSync, readFileSync, existsSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { loadArtifactFile } from "../artifact/artifact-store.js";

/** Artifact names and version files are plain identifiers — never paths. */
const SAFE_NAME = /^[\w-]+$/;
const SAFE_VERSION = /^v\d+\.json$/;
const SAFE_SCREENSHOT = /^[\w-]+\.png$/;
/** Replay may only load artifacts from the store, as the UI addresses them. */
const SAFE_ARTIFACT_PATH = /^\.\/artifacts\/[\w-]+\/v\d+\.json$/;
const MAX_GOAL_LENGTH = 2000;

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = Number(process.env.CUA_UI_PORT) || 3001;

app.use(express.json());
app.use(express.static(join(__dirname, "public")));

// --- API routes ---

/**
 * List all saved artifacts.
 * Scans artifacts/ directory for capability folders and version files.
 */
app.get("/api/artifacts", (_req, res) => {
  try {
    const artifactsDir = join(process.cwd(), "artifacts");
    if (!existsSync(artifactsDir)) {
      res.json({ artifacts: [] });
      return;
    }

    const capabilities = readdirSync(artifactsDir).filter((name) => {
      const stat = statSync(join(artifactsDir, name));
      return stat.isDirectory();
    });

    const result: Array<{ name: string; versions: string[] }> = [];
    for (const cap of capabilities) {
      const capDir = join(artifactsDir, cap);
      const versions = readdirSync(capDir)
        .filter((f) => SAFE_VERSION.test(f))
        .sort((a, b) => parseInt(a.slice(1), 10) - parseInt(b.slice(1), 10)); // v2 before v10
      result.push({ name: cap, versions });
    }

    res.json({ artifacts: result });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * Get a specific artifact by name and version.
 */
app.get("/api/artifacts/:name/:version", (req, res) => {
  try {
    const { name, version } = req.params;
    if (!SAFE_NAME.test(name) || !SAFE_VERSION.test(version)) {
      res.status(400).json({ error: "Invalid artifact name or version" });
      return;
    }
    const filePath = join(process.cwd(), "artifacts", name, version);
    if (!existsSync(filePath)) {
      res.status(404).json({ error: "Artifact not found" });
      return;
    }
    res.json(loadArtifactFile(filePath));
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * List evidence directories.
 */
app.get("/api/evidence", (_req, res) => {
  try {
    const evidenceDir = join(process.cwd(), "evidence");
    if (!existsSync(evidenceDir)) {
      res.json({ evidence: [] });
      return;
    }

    const dirs = readdirSync(evidenceDir)
      .filter((name) => statSync(join(evidenceDir, name)).isDirectory())
      .sort()
      .reverse(); // newest first

    res.json({ evidence: dirs.slice(0, 20) }); // last 20 runs
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * Get evidence run details — structured log + summary.
 */
app.get("/api/evidence/:id", (req, res) => {
  try {
    const { id } = req.params;
    if (!SAFE_NAME.test(id)) {
      res.status(400).json({ error: "Invalid evidence id" });
      return;
    }
    const dir = join(process.cwd(), "evidence", id);
    if (!existsSync(dir)) {
      res.status(404).json({ error: "Evidence not found" });
      return;
    }

    const result: Record<string, any> = { id, files: {} };

    // Read structured log if exists
    const logPath = join(dir, "structured-log.json");
    if (existsSync(logPath)) {
      result.files.structuredLog = JSON.parse(readFileSync(logPath, "utf-8"));
    }

    // Read run summary if exists
    const summaryPath = join(dir, "run-summary.json");
    if (existsSync(summaryPath)) {
      result.files.runSummary = JSON.parse(readFileSync(summaryPath, "utf-8"));
    }

    // List screenshots
    const screenshotsDir = join(dir, "screenshots");
    if (existsSync(screenshotsDir)) {
      result.files.screenshots = readdirSync(screenshotsDir).filter((f) =>
        f.endsWith(".png")
      );
    }

    // List LLM conversation
    const llmPath = join(dir, "llm-conversation.json");
    if (existsSync(llmPath)) {
      result.files.llmConversation = "exists";
    }

    res.json(result);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * Serve a screenshot file.
 */
app.get("/api/evidence/:id/screenshots/:file", (req, res) => {
  try {
    const { id, file } = req.params;
    if (!SAFE_NAME.test(id) || !SAFE_SCREENSHOT.test(file)) {
      res.status(400).send("Invalid path");
      return;
    }
    const filePath = join(process.cwd(), "evidence", id, "screenshots", file);
    if (!existsSync(filePath)) {
      res.status(404).send("Not found");
      return;
    }
    res.sendFile(filePath);
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

/**
 * Run discovery via CLI, streaming output via SSE (Server-Sent Events).
 *
 * Body: { goal: string, target: string, headed?: boolean }
 */
app.post("/api/discover", (req, res) => {
  const { goal, target, headed } = req.body ?? {};

  if (typeof goal !== "string" || !goal.trim() || goal.length > MAX_GOAL_LENGTH || goal.startsWith("-")) {
    res.status(400).json({ error: "goal must be a non-empty string" });
    return;
  }
  if (!isHttpUrl(target)) {
    res.status(400).json({ error: "target must be an http(s) URL" });
    return;
  }

  // Set up SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const args = [
    "src/cli/index.ts",
    "discover",
    "--goal", goal,
    "--target", target,
  ];
  if (headed === true) args.push("--headed");

  const child = spawn(process.execPath, ["--import", "tsx", ...args], {
    cwd: process.cwd(),
    env: { ...process.env },
  });

  const sendSSE = (event: string, data: any) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  child.stdout.on("data", (data) => {
    const lines = data.toString().split("\n").filter((l: string) => l.trim());
    for (const line of lines) {
      sendSSE("output", { line });
    }
  });

  child.stderr.on("data", (data) => {
    const lines = data.toString().split("\n").filter((l: string) => l.trim());
    for (const line of lines) {
      sendSSE("output", { line });
    }
  });

  child.on("close", (code) => {
    sendSSE("done", { exitCode: code });
    res.end();
  });

  child.on("error", (err) => {
    sendSSE("error", { error: String(err) });
    res.end();
  });
});

/**
 * Run replay via CLI, streaming output via SSE.
 *
 * Body: { artifact: string, params: Record<string, string>, target: string, headed?: boolean }
 */
app.post("/api/replay", (req, res) => {
  const { artifact, params, target, headed } = req.body ?? {};

  if (typeof artifact !== "string" || !SAFE_ARTIFACT_PATH.test(artifact)) {
    res.status(400).json({ error: "artifact must be ./artifacts/<name>/v<N>.json" });
    return;
  }
  if (!isHttpUrl(target)) {
    res.status(400).json({ error: "target must be an http(s) URL" });
    return;
  }
  if (params !== undefined && !isStringRecord(params)) {
    res.status(400).json({ error: "params must be an object of strings" });
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const args = [
    "src/cli/index.ts",
    "replay",
    "--artifact", artifact,
    "--target", target,
  ];
  if (params && Object.keys(params).length > 0) {
    args.push("--params", JSON.stringify(params));
  }
  if (headed === true) args.push("--headed");

  const child = spawn(process.execPath, ["--import", "tsx", ...args], {
    cwd: process.cwd(),
    env: { ...process.env },
  });

  const sendSSE = (event: string, data: any) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  child.stdout.on("data", (data) => {
    const lines = data.toString().split("\n").filter((l: string) => l.trim());
    for (const line of lines) {
      sendSSE("output", { line });
    }
  });

  child.stderr.on("data", (data) => {
    const lines = data.toString().split("\n").filter((l: string) => l.trim());
    for (const line of lines) {
      sendSSE("output", { line });
    }
  });

  child.on("close", (code) => {
    sendSSE("done", { exitCode: code });
    res.end();
  });

  child.on("error", (err) => {
    sendSSE("error", { error: String(err) });
    res.end();
  });
});

/**
 * Get config (model, provider, etc.)
 */
app.get("/api/config", (_req, res) => {
  try {
    const configPath = join(process.cwd(), "cua.config.json");
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      res.json({ config });
    } else {
      res.json({ config: null });
    }
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

const server = app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════╗`);
  console.log(`║  Computer-Use Automation UI              ║`);
  console.log(`║  http://localhost:${PORT}                    ║`);
  console.log(`╚══════════════════════════════════════════╝\n`);
  console.log(`  Press Ctrl+C to stop\n`);
});

// Graceful shutdown — release the port on SIGINT/SIGTERM
const shutdown = () => {
  console.log("\nShutting down...");
  server.close(() => {
    process.exit(0);
  });
  // Force exit after 2s if server.close hangs
  setTimeout(() => process.exit(0), 2000);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => server.close());

export { app, server };
