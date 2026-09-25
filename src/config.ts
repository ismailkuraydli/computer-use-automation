/**
 * Config — loads model/provider settings from .env + cua.config.json.
 * Supports any OpenRouter-compatible model (Gemini, GPT-4o, Claude, etc.)
 */

import { readFileSync, existsSync } from "fs";
import path from "path";
import dotenv from "dotenv";

// Auto-load .env on import. Quiet: dotenv's banner goes to stdout, which is
// the protocol channel when running as an MCP server.
dotenv.config({ quiet: true });

export interface CuaConfig {
  provider: string;           // "openrouter", "openai", "anthropic", etc.
  model: string;              // "google/gemini-2.0-flash-001", "anthropic/claude-3.5-sonnet", "openai/gpt-4o"
  baseUrl: string;            // API endpoint
  apiKeyEnvVar: string;      // env var name for the API key
  maxTokens: number;
  maxSteps: number;
  timeoutMs: number;
  headless: boolean;
}

const DEFAULT_CONFIG: CuaConfig = {
  provider: "openrouter",
  model: "google/gemini-3.5-flash-lite",
  baseUrl: "https://openrouter.ai/api/v1/chat/completions",
  apiKeyEnvVar: "OPENROUTER_API_KEY",
  maxTokens: 2000,
  maxSteps: 30,
  timeoutMs: 120000,
  headless: true,
};

export function loadConfig(configPath?: string): CuaConfig {
  const resolvedPath = configPath || path.join(process.cwd(), "cua.config.json");

  if (!existsSync(resolvedPath)) {
    return DEFAULT_CONFIG;
  }

  try {
    const content = readFileSync(resolvedPath, "utf-8");
    const userConfig = JSON.parse(content);
    return { ...DEFAULT_CONFIG, ...userConfig };
  } catch (e) {
    console.warn(`Warning: could not parse ${resolvedPath}, using defaults. ${(e as Error).message}`);
    return DEFAULT_CONFIG;
  }
}

export function getApiKey(config: CuaConfig): string {
  const key = process.env[config.apiKeyEnvVar];
  if (!key) {
    throw new Error(
      `${config.apiKeyEnvVar} is not set. Set it in .env or: export ${config.apiKeyEnvVar}=your-key\n` +
      `Or run discover with --mock-llm to use scripted responses (no real API calls).`
    );
  }
  return key;
}

/**
 * Pre-flight check: verify the model is accessible before starting a run.
 * Sends a minimal request to the LLM API and checks the response.
 * Returns { ok: true } or { ok: false, error }.
 */
export async function checkModelAccessible(config: CuaConfig): Promise<{ ok: true } | { ok: false; error: string }> {
  let apiKey: string;
  try {
    apiKey = getApiKey(config);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }

  try {
    const response = await fetch(config.baseUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
    });

    if (response.ok) {
      return { ok: true };
    }

    const errorBody = await response.text().catch(() => "");
    if (response.status === 401 || response.status === 403) {
      return { ok: false, error: `API key invalid or unauthorized (${response.status}). Check ${config.apiKeyEnvVar} in .env.` };
    }
    if (response.status === 404) {
      return { ok: false, error: `Model "${config.model}" not found. Check cua.config.json — available models: https://openrouter.ai/models` };
    }
    if (response.status === 429) {
      return { ok: false, error: `Rate limited (429). Try again in a moment or use a different model.` };
    }
    return { ok: false, error: `API error ${response.status}: ${errorBody || response.statusText}` };
  } catch (e) {
    return { ok: false, error: `Cannot reach ${config.baseUrl}: ${String(e)}` };
  }
}
