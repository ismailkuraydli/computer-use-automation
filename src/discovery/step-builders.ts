/**
 * Turn one discovery action into a replayable target and checkpoint.
 *
 * Targets describe what an operator sees. A value read from a table becomes
 * "the Balance cell of the Savings row" or "the value next to Current
 * Balance" — never the literal value seen during discovery. A control that
 * repeats on every row gets a row scope.
 *
 * Checkpoints are small and stable: the model's own expectation, controls
 * and column headers that appeared because of the action, and the URL shape
 * with non-parameter values wildcarded.
 */

import type { Action, AXNode, ScreenState } from "../surface/types.js";
import type { ScreenSignature, StateGuard, TargetSpec } from "../artifact/types.js";

const MAX_ANCHORS = 2;
const MAX_ANCHOR_LENGTH = 60;
const ANCHOR_ROLES = new Set(["textbox", "searchbox", "combobox", "button", "columnheader"]);
const PAGE_CHANGING_ACTIONS = new Set(["navigate", "click", "submit"]);

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export function buildTarget(action: Action, before: ScreenState, paramValues: string[]): TargetSpec | undefined {
  if (!action.target) return undefined;
  const { role, name, row, frame } = action.target;
  const node = findNode(before.axTree, role, name, row);
  const base: TargetSpec = { role, ...(name ? { name } : {}), ...(row ? { row } : {}), ...(frame?.length ? { frame } : {}) };

  if (action.type === "extract" && node?.context) {
    if (node.context.label) return { role, label: node.context.label, ...(frame?.length ? { frame } : {}) };
    const key = rowKey(node, paramValues);
    if (node.context.column && key) return { role, row: key, column: node.context.column, ...(frame?.length ? { frame } : {}) };
  }

  if (!base.row && node?.context?.row && countSame(before.axTree, node) > 1) {
    const key = rowKey(node, paramValues);
    if (key) return { ...base, row: key };
  }
  return base;
}

export function buildCheckpoint(
  action: Action,
  before: ScreenState,
  after: ScreenState,
  expect: string | undefined,
  paramValues: string[]
): StateGuard | undefined {
  if (!PAGE_CHANGING_ACTIONS.has(action.type)) return undefined;

  // The model's expectation must be UI text, not record data that changes
  // per invocation (a member's name in a results table, a balance).
  // It must also be on the page right now — models predict text that never appears.
  const usableExpect =
    expect && !isTableData(expect, before, after) && onOneElement(after, expect) ? expect : undefined;

  const sig: ScreenSignature = {};
  if (usableExpect) sig.textContains = usableExpect;

  const urlChanged = urlKey(after.url) !== urlKey(before.url) || action.type === "navigate";
  if (urlChanged) {
    const pattern = urlPattern(after.url, paramValues);
    if (pattern) sig.urlPattern = pattern;
  }

  if (!usableExpect) {
    const anchors = newAnchors(before, after);
    if (anchors.length > 0) sig.axContains = anchors;
  }

  return Object.keys(sig).length > 0 ? { anyOf: [sig] } : undefined;
}

/** Inside a single element — not stitched together from neighbouring cells. */
function onOneElement(state: ScreenState, text: string): boolean {
  const wanted = norm(text);
  return state.axTree.some((n) => norm(n.name).includes(wanted));
}

/** Text that is the content of a data cell (a cell under a column header). */
function isTableData(text: string, ...states: ScreenState[]): boolean {
  const wanted = norm(text);
  return states.some((s) =>
    s.axTree.some((n) => n.role === "cell" && n.context?.column && norm(n.name) === wanted)
  );
}

function findNode(tree: AXNode[], role: string, name?: string, row?: string): AXNode | undefined {
  return tree.find(
    (n) =>
      n.role === role &&
      (!name || norm(n.name) === norm(name)) &&
      (!row || (n.context?.row ?? []).some((cell) => norm(cell) === norm(row)))
  );
}

function countSame(tree: AXNode[], node: AXNode): number {
  return tree.filter((n) => n.role === node.role && norm(n.name) === norm(node.name)).length;
}

/** The row cell that identifies the node's row: a param value if present, else the first other cell. */
function rowKey(node: AXNode, paramValues: string[]): string | undefined {
  const cells = (node.context?.row ?? []).filter((c) => c && norm(c) !== norm(node.name));
  const byParam = cells.find((c) => paramValues.some((v) => norm(v) === norm(c)));
  return byParam ?? cells[0];
}

/** Static controls and column headers that this action made appear. */
function newAnchors(before: ScreenState, after: ScreenState): { role: string; name: string }[] {
  const existed = new Set(before.axTree.map((n) => `${n.role}:${norm(n.name)}`));
  const anchors: { role: string; name: string }[] = [];
  for (const n of after.axTree) {
    if (anchors.length >= MAX_ANCHORS) break;
    if (!ANCHOR_ROLES.has(n.role) || !n.name || n.name.length > MAX_ANCHOR_LENGTH || /\d/.test(n.name)) continue;
    const key = `${n.role}:${norm(n.name)}`;
    if (existed.has(key) || anchors.some((a) => `${a.role}:${norm(a.name)}` === key)) continue;
    anchors.push({ role: n.role, name: n.name.trim() });
  }
  return anchors;
}

function urlKey(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** Path plus query keys; values stay only when they are parameter values. */
function urlPattern(url: string, paramValues: string[]): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const query = Array.from(parsed.searchParams.entries())
    .map(([k, v]) => `${k}=${paramValues.some((p) => norm(p) === norm(v)) ? v : "*"}`)
    .join("&");
  return query ? `${parsed.pathname}?${query}` : parsed.pathname;
}
