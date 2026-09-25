/**
 * CLI argument parsing with readable errors. Node's parseArgs throws a raw
 * ERR_PARSE_ARGS_* stack; the most common cause is `--artifact $A` with an
 * unset shell variable, so say that plainly.
 */

import { parseArgs } from "util";

const OPTIONS = {
  goal: { type: "string" },
  target: { type: "string", default: "http://localhost:3000" },
  output: { type: "string", default: "./artifacts" },
  artifact: { type: "string" },
  params: { type: "string", default: "{}" },
  tenant: { type: "string" },
  "base-url": { type: "string" },
  "mock-llm": { type: "boolean", default: false },
  headed: { type: "boolean", default: false },
  config: { type: "string" },
  allowlist: { type: "string" },
  app: { type: "string" },
  confirm: { type: "boolean", default: false },
  handoff: { type: "boolean", default: false },
  help: { type: "boolean", default: false },
} as const;

type Parsed = ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;

export type CliValues = Parsed["values"];

export type CliArgs =
  | { ok: true; command: string | undefined; values: CliValues }
  | { ok: false; message: string };

export function parseCliArgs(argv: string[]): CliArgs {
  try {
    const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: OPTIONS });
    return { ok: true, command: positionals[0], values };
  } catch (e) {
    return { ok: false, message: explain(e) };
  }
}

function explain(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const code = (e as { code?: string }).code ?? "";
  const option = message.match(/'(-{1,2}[\w-]+)/)?.[1] ?? "option";

  if (code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE") {
    const example = option === "--artifact" ? " (e.g. --artifact artifacts/<capability>/v1.json)" : "";
    return (
      `${option} needs a value${example}.\n` +
      `If you passed a shell variable (${option} $A), it is empty in this terminal.`
    );
  }
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION") {
    return `Unknown option ${option}.`;
  }
  return message.split("\n")[0];
}
