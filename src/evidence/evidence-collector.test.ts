import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { EvidenceCollector } from "./evidence-collector.js";
import { rmSync, existsSync, readFileSync } from "fs";
import path from "path";

const TEST_EVIDENCE_DIR = path.join(process.cwd(), "test-evidence");

describe("EvidenceCollector", () => {
  let collector: EvidenceCollector;

  beforeEach(() => {
    rmSync(TEST_EVIDENCE_DIR, { recursive: true, force: true });
    collector = new EvidenceCollector(TEST_EVIDENCE_DIR);
  });

  afterEach(() => {
    rmSync(TEST_EVIDENCE_DIR, { recursive: true, force: true });
  });

  // AC6: Given any step in the discovery run, when EvidenceCollector logs it,
  // then a structured JSON log entry + screenshot + AX snapshot are saved to /evidence/{run-id}/.
  it("creates an evidence directory with a run ID", () => {
    expect(existsSync(collector.runDir)).toBe(true);
    expect(collector.runId).toBeTruthy();
  });

  it("logs a step with structured JSON entry", () => {
    collector.logStep({
      step: 1,
      action: "navigate",
      target: "http://localhost:3000/search",
      result: "success",
      url: "http://localhost:3000/search",
      screenshotPath: "/tmp/test.png",
      axSnapshot: [{ role: "textbox", name: "Member ID" }],
    });

    const logPath = path.join(collector.runDir, "structured-log.json");
    const log = JSON.parse(readFileSync(logPath, "utf-8"));
    expect(log.steps).toHaveLength(1);
    expect(log.steps[0].step).toBe(1);
    expect(log.steps[0].action).toBe("navigate");
    expect(log.steps[0].result).toBe("success");
  });

  it("logs multiple steps in order", () => {
    collector.logStep({ step: 1, action: "navigate", target: "url1", result: "success", url: "url1" });
    collector.logStep({ step: 2, action: "click", target: "button", result: "success", url: "url2" });
    collector.logStep({ step: 3, action: "type", target: "textbox", result: "success", url: "url2" });

    const logPath = path.join(collector.runDir, "structured-log.json");
    const log = JSON.parse(readFileSync(logPath, "utf-8"));
    expect(log.steps).toHaveLength(3);
    expect(log.steps[2].step).toBe(3);
  });

  it("saves an AX snapshot to a separate file", () => {
    const axTree = [{ role: "textbox", name: "Member ID" }, { role: "button", name: "Search" }];
    collector.logStep({
      step: 1,
      action: "observe",
      target: "",
      result: "success",
      url: "http://localhost:3000/search",
      axSnapshot: axTree,
    });

    const axPath = path.join(collector.runDir, "step-1-ax.json");
    expect(existsSync(axPath)).toBe(true);
    const ax = JSON.parse(readFileSync(axPath, "utf-8"));
    expect(ax).toEqual(axTree);
  });

  it("writes a run summary at the end", () => {
    collector.logStep({ step: 1, action: "navigate", target: "url", result: "success", url: "url" });
    collector.logStep({ step: 2, action: "click", target: "button", result: "failure", url: "url" });

    collector.writeSummary({
      goal: "Look up member 12345",
      totalSteps: 2,
      success: true,
      outputs: { savingsBalance: "$12,847.00" },
    });

    const summaryPath = path.join(collector.runDir, "run-summary.json");
    expect(existsSync(summaryPath)).toBe(true);
    const summary = JSON.parse(readFileSync(summaryPath, "utf-8"));
    expect(summary.goal).toBe("Look up member 12345");
    expect(summary.totalSteps).toBe(2);
    expect(summary.outputs.savingsBalance).toBe("$12,847.00");
  });

  it("redacts regulated data in AX snapshots and LLM logs", () => {
    collector.logStep({
      step: 1,
      action: "observe",
      target: "",
      result: "success",
      url: "http://localhost:3000/detail?id=12345",
      axSnapshot: [
        { role: "cell", name: "123-45-6789" },
        { role: "cell", name: "2003004005", context: { row: ["Savings", "2003004005"] } },
      ],
    });
    collector.logLLMCall({
      step: 1,
      request: { screenStateAxTree: [{ role: "cell", name: "123-45-6789" }] },
      response: { ok: true },
    } as never);

    const files = ["step-1-ax.json", "llm-conversation.json"].map((f) => readFileSync(path.join(collector.runDir, f), "utf-8"));
    for (const content of files) {
      expect(content).not.toContain("123-45-6789");
      expect(content).not.toContain("2003004005");
      expect(content).toContain("[REDACTED]");
    }
  });
});
