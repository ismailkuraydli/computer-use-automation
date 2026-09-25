import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenRouterClient } from "./openrouter-client.js";
import { SensitiveDataRedactor } from "../safety/sensitive-data.js";
import type { CuaConfig } from "../config.js";
import type { ScreenState } from "../surface/types.js";

const CONFIG: CuaConfig = {
  provider: "openrouter",
  model: "test/model",
  baseUrl: "https://llm.invalid/v1/chat/completions",
  apiKeyEnvVar: "X",
  maxTokens: 100,
  maxSteps: 5,
  timeoutMs: 1000,
  headless: true,
};

const DETAIL: ScreenState = {
  url: "http://localhost:3000/detail?id=23456",
  title: "Keystone CU - Member Detail",
  axTree: [
    { role: "heading", name: "Member Detail - Maria B. Johnson" },
    { role: "cell", name: "234-56-7890", context: { row: ["23456", "234-56-7890", "1982-07-22"], column: "SSN" } },
    { role: "cell", name: "1982-07-22", context: { row: ["23456", "234-56-7890", "1982-07-22"], column: "DOB" } },
  ],
  domSnapshot: "",
  frameUrls: [],
};

afterEach(() => vi.unstubAllGlobals());

describe("OpenRouterClient data boundary", () => {
  it("never sends names, dates of birth or SSNs to the model provider", async () => {
    const bodies: string[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      bodies.push(init.body);
      const content = JSON.stringify({ action: { type: "wait", value: "10" }, reasoning: "", goalMet: false });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    });

    const redactor = new SensitiveDataRedactor({ fields: ["DOB", "SSN"], patterns: ["^Member Detail - (.+)$"] });
    redactor.learn(DETAIL.axTree); // the surface does this on every observe()
    const client = new OpenRouterClient("key", CONFIG, redactor);

    const response = await client.decide({ goal: "Read the balance", screenState: DETAIL, history: [], stepNumber: 1 });

    expect(response.ok).toBe(true);
    const sent = bodies.join("\n");
    expect(sent).not.toContain("Maria B. Johnson");
    expect(sent).not.toContain("1982-07-22");
    expect(sent).not.toContain("234-56-7890");
    expect(sent).toContain("Member Detail - [REDACTED]");
  });
});
