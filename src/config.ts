/**
 * Config — loads model/provider settings from cua.config.json.
 * Supports any OpenRouter-compatible model (Gemini, GPT-4o, Claude, etc.)
 */

import { readFileSync, existsSync } from "fs";
import path from "path";

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
  model: "google/gemini-2.0-flash-001",
  baseUrl: "https://openrouter.ai/api/v1/chat/completions",
  apiKeyEnvVar: "OPENROUTER_API_KEY",
  maxTokens: 1000,
  maxSteps: 15,
  timeoutMs: 60000,
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
      `${config.apiKeyEnvVar} is not set. Set it with: export ${config.apiKeyEnvVar}=your-key\n` +
      `Or run discover with --mock-llm to use scripted responses (no real API calls).`
    );
  }
  return key;
}
