/**
 * EvidenceCollector — collects structured logs, screenshots, AX snapshots per run.
 * Per the assignment: produce enough evidence to understand and debug a run.
 */

import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { randomUUID } from "crypto";
import type { AXNode, TargetSpec } from "../surface/types.js";
import { SensitiveDataRedactor } from "../safety/sensitive-data.js";

export interface LogStepEntry {
  step: number;
  action: string;
  target: string;
  result: "success" | "failure";
  url: string;
  screenshotPath?: string;
  axSnapshot?: AXNode[];
  detail?: string;
}

export interface RunSummary {
  goal: string;
  totalSteps: number;
  success: boolean;
  outputs?: Record<string, string>;
  error?: string;
}

export interface LLMLogEntry {
  step: number;
  request: {
    goal: string;
    screenStateUrl: string;
    screenStateAxTree: AXNode[];
    history: Array<{ step: number; actionType: string; result: string }>;
    stepNumber: number;
  };
  response: {
    ok: boolean;
    action?: { type: string; target?: TargetSpec; value?: string };
    reasoning?: string;
    goalMet?: boolean;
    subGoalComplete?: boolean;
    outputComplete?: boolean;
    error?: string;
  };
  timestamp: string;
}

export class EvidenceCollector {
  readonly runId: string;
  readonly runDir: string;
  readonly screenshotDir: string;
  private steps: LogStepEntry[] = [];
  private llmLogs: LLMLogEntry[] = [];

  /** Redacts everything written; learns sensitive values as the surface observes. */
  readonly redactor: SensitiveDataRedactor;

  constructor(baseDir: string = "./evidence", redactor: SensitiveDataRedactor = new SensitiveDataRedactor()) {
    this.redactor = redactor;
    this.runId = randomUUID().slice(0, 8);
    this.runDir = path.join(baseDir, this.runId);
    this.screenshotDir = path.join(this.runDir, "screenshots");
    mkdirSync(this.screenshotDir, { recursive: true });
  }

  logStep(entry: LogStepEntry): void {
    // Redact PII from everything that is logged, snapshots included
    const redacted: LogStepEntry = this.redactor.redactDeep(entry);

    this.steps.push(redacted);

    // Write structured log (updated each step)
    const logPath = path.join(this.runDir, "structured-log.json");
    writeFileSync(logPath, JSON.stringify({ steps: this.steps }, null, 2));

    // Save AX snapshot to separate file
    if (entry.axSnapshot) {
      const axPath = path.join(this.runDir, `step-${entry.step}-ax.json`);
      writeFileSync(axPath, JSON.stringify(redacted.axSnapshot, null, 2));
    }
  }

  logLLMCall(entry: LLMLogEntry): void {
    this.llmLogs.push(this.redactor.redactDeep(entry));

    // Write LLM conversation log (updated each call)
    const llmLogPath = path.join(this.runDir, "llm-conversation.json");
    writeFileSync(llmLogPath, JSON.stringify(this.llmLogs, null, 2));
  }

  writeSummary(summary: RunSummary): void {
    const summaryPath = path.join(this.runDir, "run-summary.json");
    const redacted: RunSummary = {
      ...summary,
      outputs: summary.outputs
        ? Object.fromEntries(
            Object.entries(summary.outputs).map(([k, v]) => [k, typeof v === "string" ? this.redactor.redact(v) : String(v)])
          )
        : undefined,
      error: summary.error ? this.redactor.redact(summary.error) : undefined,
    };
    writeFileSync(summaryPath, JSON.stringify(redacted, null, 2));
  }
}
