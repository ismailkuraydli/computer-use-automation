import { describe, it, expect } from "vitest";
import { redactPII } from "./pii-redactor.js";

describe("PII Redactor", () => {
  // AC5: Given any ScreenState, when SafetyGuard checks PII redaction patterns
  // (SSN, account numbers), then matched patterns are replaced with [REDACTED]

  it("redacts SSN in format XXX-XX-XXXX", () => {
    const input = "Member SSN: 123-45-6789";
    const result = redactPII(input);
    expect(result).toBe("Member SSN: [REDACTED]");
    expect(result).not.toContain("123-45-6789");
  });

  it("redacts multiple SSNs in the same string", () => {
    const input = "Primary: 123-45-6789, Joint: 234-56-7890";
    const result = redactPII(input);
    expect(result).toBe("Primary: [REDACTED], Joint: [REDACTED]");
  });

  it("redacts 10-12 digit account numbers", () => {
    const input = "Account Number: 1002003004";
    const result = redactPII(input);
    expect(result).toBe("Account Number: [REDACTED]");
  });

  it("redacts 12-digit account numbers", () => {
    const input = "Transfer from 123456789012 to 987654321099";
    const result = redactPII(input);
    expect(result).toBe("Transfer from [REDACTED] to [REDACTED]");
  });

  it("does not redact short numbers (under 10 digits)", () => {
    const input = "Member ID: 12345, Balance: $4,521.33";
    const result = redactPII(input);
    expect(result).toBe("Member ID: 12345, Balance: $4,521.33");
  });

  it("does not redact phone numbers (different format from SSN)", () => {
    const input = "Phone: 555-123-4567";
    const result = redactPII(input);
    // Phone numbers are XXX-XXX-XXXX, SSNs are XXX-XX-XXXX — different middle group length
    expect(result).toBe("Phone: 555-123-4567");
  });

  it("redacts credit card numbers (16 consecutive digits)", () => {
    const input = "Card: 4111111111111111";
    const result = redactPII(input);
    expect(result).toBe("Card: [REDACTED]");
  });

  it("redacts credit card numbers with spaces", () => {
    const input = "Card: 4111 1111 1111 1111";
    const result = redactPII(input);
    expect(result).toBe("Card: [REDACTED]");
  });

  it("returns non-PII strings unchanged", () => {
    const input = "Member ID: 12345, Status: Active";
    const result = redactPII(input);
    expect(result).toBe("Member ID: 12345, Status: Active");
  });

  it("handles empty strings", () => {
    expect(redactPII("")).toBe("");
  });

  it("redacts SSNs embedded in longer text", () => {
    const input = "The member with SSN 123-45-6789 has 2 accounts with total balance $45,200.00";
    const result = redactPII(input);
    expect(result).toBe("The member with SSN [REDACTED] has 2 accounts with total balance $45,200.00");
  });

  it("redacts balance amounts that look like account numbers in context", () => {
    // $45,200.00 should NOT be redacted — it has commas and decimals
    const input = "Balance: $45,200.00 Account: 7008009010";
    const result = redactPII(input);
    expect(result).toContain("$45,200.00");
    expect(result).toContain("[REDACTED]");
  });

  it("redacts numbers glued to text by legacy layout cells", () => {
    expect(redactPII("Checking1002003004$4,521.33")).toBe("Checking[REDACTED]$4,521.33");
    expect(redactPII("SSN123-45-6789DOB")).toBe("SSN[REDACTED]DOB");
    expect(redactPII("12345123-45-67891975-03-15")).toBe("12345[REDACTED]1975-03-15");
  });

  it("leaves shorter and longer digit runs alone", () => {
    expect(redactPII("member 12345")).toBe("member 12345");
    expect(redactPII("ref 1234567890123")).toBe("ref 1234567890123");
  });
});
