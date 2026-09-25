import { describe, it, expect } from "vitest";
import { parseCliArgs } from "./args.js";

describe("parseCliArgs", () => {
  it("parses a command and its options", () => {
    const parsed = parseCliArgs(["replay", "--artifact", "a/v1.json", "--params", '{"x":"1"}', "--confirm"]);

    expect(parsed).toMatchObject({
      ok: true,
      command: "replay",
      values: { artifact: "a/v1.json", params: '{"x":"1"}', confirm: true },
    });
  });

  it("explains an option whose value is missing because a shell variable was empty", () => {
    // `--artifact $A` with A unset becomes `--artifact --params ...`
    const parsed = parseCliArgs(["replay", "--artifact", "--params", "{}"]);

    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.message).toContain("--artifact needs a value");
      expect(parsed.message).toContain("shell variable");
      expect(parsed.message).not.toContain("ERR_PARSE_ARGS");
    }
  });

  it("explains an option given last with no value", () => {
    const parsed = parseCliArgs(["replay", "--artifact"]);

    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) expect(parsed.message).toContain("--artifact needs a value");
  });

  it("reports an unknown option by name", () => {
    const parsed = parseCliArgs(["replay", "--artefact", "a.json"]);

    expect(parsed).toMatchObject({ ok: false });
    if (!parsed.ok) expect(parsed.message).toContain("Unknown option --artefact");
  });
});
