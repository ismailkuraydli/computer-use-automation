/**
 * PII Redactor — redacts sensitive financial data from evidence and artifacts.
 * Per ADR-005: never persist secrets or raw sensitive data.
 *
 * Patterns covered:
 * - SSN: XXX-XX-XXXX
 * - Account numbers: 10-12 consecutive digits
 * - Credit card numbers: 16 consecutive digits (with or without spaces)
 */

const SSN_PATTERN = /\b\d{3}-\d{2}-\d{4}\b/g;

// Account numbers: 10-12 consecutive digits, not preceded/followed by more digits
// Must NOT match things like $45,200.00 (has commas/decimals) or phone numbers with dashes in different positions
const ACCOUNT_NUMBER_PATTERN = /\b\d{10,12}\b/g;

// Credit card: 16 digits, optionally separated by spaces in groups of 4
const CREDIT_CARD_PATTERN = /\b(?:\d{4}\s?){3}\d{4}\b/g;

/** Matches any text that contains a known PII pattern — for masking screenshots. */
export const PII_TEXT_PATTERN = new RegExp(
  [CREDIT_CARD_PATTERN, SSN_PATTERN, ACCOUNT_NUMBER_PATTERN].map((p) => p.source).join("|")
);

/**
 * Redact all known PII patterns from a string, replacing them with [REDACTED].
 * If the input is not a string, returns it as-is.
 */
export function redactPII(text: string): string {
  if (typeof text !== "string") return text;
  let result = text;

  // Redact credit cards first (16 digits with optional spaces)
  // so they don't get partially matched by account number patterns
  result = result.replace(CREDIT_CARD_PATTERN, "[REDACTED]");

  // Redact SSNs
  result = result.replace(SSN_PATTERN, "[REDACTED]");

  // Redact account numbers (10-12 consecutive digits)
  result = result.replace(ACCOUNT_NUMBER_PATTERN, "[REDACTED]");

  return result;
}

/**
 * Redact an object's string values recursively.
 * Non-string values are returned as-is.
 */
export function redactPIIInObject<T>(obj: T): T {
  if (typeof obj === "string") {
    return redactPII(obj) as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map(redactPIIInObject) as unknown as T;
  }
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = redactPIIInObject(value);
    }
    return result as unknown as T;
  }
  return obj;
}
