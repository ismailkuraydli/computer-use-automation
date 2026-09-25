/**
 * {{param}} substitution over artifact data (targets, values, guards).
 * Returns new objects; the artifact itself is never mutated.
 */

export type Params = Record<string, string>;

const TEMPLATE = /\{\{\s*([\w-]+)\s*\}\}/g;

export function substitute(text: string, params: Params): string {
  return text.replace(TEMPLATE, (match, name: string) => params[name] ?? match);
}

/** Deep-substitute every string inside a JSON-like value. */
export function substituteDeep<T>(value: T, params: Params): T {
  if (typeof value === "string") return substitute(value, params) as T;
  if (Array.isArray(value)) return value.map((v) => substituteDeep(v, params)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, substituteDeep(v, params)])
    ) as T;
  }
  return value;
}

/** Names of required params that are missing or empty. */
export function missingParams(required: string[], params: Params): string[] {
  return required.filter((name) => !params[name] || params[name].trim() === "");
}
