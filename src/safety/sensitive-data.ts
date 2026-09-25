/**
 * SensitiveDataRedactor — one per run. Redacts regulated data that patterns
 * alone cannot recognize (names, dates of birth) by learning it from the
 * screens themselves.
 *
 * The app profile says WHERE sensitive data sits:
 * - fields: table column headers or key/value labels ("Name", "DOB");
 * - patterns: regexes whose first capture group is sensitive
 *   ("Member Detail - (.+)").
 * Every value found there is learned and then scrubbed from ALL text for the
 * rest of the run (headings, LLM prompts, logs, artifacts, screenshots),
 * on top of the fixed SSN / account / card patterns.
 */

import type { AXNode } from "../surface/types.js";
import { redactPII, PII_TEXT_PATTERN } from "./pii-redactor.js";

export interface SensitiveDataSpec {
  /** Column headers or labels whose values are sensitive. */
  fields?: string[];
  /** Regexes whose first capture group is sensitive. */
  patterns?: string[];
}

const REDACTED = "[REDACTED]";
/** Shorter values ("Yes", "M") would scrub unrelated text. */
const MIN_VALUE_LENGTH = 3;

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export class SensitiveDataRedactor {
  private readonly fields: Set<string>;
  private readonly patterns: RegExp[];
  private readonly values = new Set<string>();
  private scrubber: RegExp | null = null;

  constructor(spec: SensitiveDataSpec = {}) {
    this.fields = new Set((spec.fields ?? []).map(norm));
    this.patterns = (spec.patterns ?? []).map((p) => new RegExp(p, "i"));
  }

  /** Learn the sensitive values visible in a snapshot. */
  learn(tree: AXNode[]): void {
    for (const node of tree) {
      const field = node.context?.label ?? node.context?.column;
      if (field && this.fields.has(norm(field)) && norm(field) !== norm(node.name)) this.add(node.name);
      for (const pattern of this.patterns) {
        const match = node.name.match(pattern);
        if (match?.[1]) this.add(match[1]);
      }
    }
  }

  redact(text: string): string {
    if (typeof text !== "string") return text;
    const scrubbed = this.scrubber ? text.replace(this.scrubber, REDACTED) : text;
    return redactPII(scrubbed);
  }

  redactDeep<T>(value: T): T {
    if (typeof value === "string") return this.redact(value) as T;
    if (Array.isArray(value)) return value.map((v) => this.redactDeep(v)) as T;
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, this.redactDeep(v)])) as T;
    }
    return value;
  }

  /** What a screenshot must cover: the fixed patterns plus every learned value. */
  get maskTexts(): Array<RegExp | string> {
    return [PII_TEXT_PATTERN, ...this.values];
  }

  private add(raw: string): void {
    const value = raw.replace(/\s+/g, " ").trim();
    if (value.length < MIN_VALUE_LENGTH || value === REDACTED) return;
    this.values.add(value);
    // Longest first, so "John A. Smith (12345)" wins over "John A. Smith"
    const alternatives = [...this.values].sort((a, b) => b.length - a.length).map((v) => escape(v).replace(/ /g, "\\s+"));
    this.scrubber = new RegExp(alternatives.join("|"), "gi");
  }
}
