/**
 * The single place a TargetSpec becomes a live element.
 *
 * Resolution is semantic and strict: whole-text, case-insensitive matching on
 * what an operator sees (role + accessible name, table row, column header,
 * field label). It never picks "the first of several" — more than one match is
 * reported as ambiguous so the artifact gets fixed (e.g. with a row scope)
 * instead of silently acting on the wrong element.
 */

import type { Frame, Locator, Page } from "playwright";
import type { TargetSpec } from "../artifact/types.js";

export type Resolution =
  | { ok: true; locator: Locator }
  | { ok: false; error: "element-not-found" | "ambiguous"; detail: string };

/** How long resolution keeps polling for a target that is not there yet. */
export const RESOLVE_TIMEOUT_MS = 5000;
const POLL_INTERVAL_MS = 200;

const FORM_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "listbox"]);

type Root = Page | Frame;

export function exactText(text: string): RegExp {
  const escaped = text.trim().replace(/\s+/g, " ").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\s*${escaped.replace(/ /g, "\\s+")}\\s*$`, "i");
}

export function describeTarget(target: TargetSpec): string {
  const parts = [target.role];
  if (target.name) parts.push(`"${target.name}"`);
  if (target.label) parts.push(`labelled "${target.label}"`);
  if (target.row) parts.push(`in row "${target.row}"`);
  if (target.column) parts.push(`under column "${target.column}"`);
  if (target.frame?.length) parts.push(`in frame ${target.frame.join(" > ")}`);
  return parts.join(" ");
}

/** Resolve a target, polling until it appears or the timeout passes. */
export async function resolveTarget(page: Page, target: TargetSpec, timeoutMs = RESOLVE_TIMEOUT_MS): Promise<Resolution> {
  const deadline = Date.now() + timeoutMs;
  let last: Resolution = { ok: false, error: "element-not-found", detail: `No ${describeTarget(target)}` };

  while (Date.now() < deadline) {
    last = await resolveOnce(page, target);
    // Ambiguity is a property of the artifact, not of timing — report it now.
    if (last.ok || last.error === "ambiguous") return last;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return last;
}

async function resolveOnce(page: Page, target: TargetSpec): Promise<Resolution> {
  const root = findFrame(page, target.frame ?? []);
  if (!root) {
    return { ok: false, error: "element-not-found", detail: `Frame ${target.frame!.join(" > ")} not found` };
  }

  let scope: Root | Locator = root;
  if (target.row) {
    const row = await unique(rowContaining(root, target.row), `table row containing "${target.row}"`);
    if (!row.ok) return row;
    scope = row.locator;
  }

  if (target.label) return resolveByLabel(scope, target.label);
  if (target.column) {
    if (!target.row) return { ok: false, error: "element-not-found", detail: "column targets need a row" };
    return resolveColumnCell(scope as Locator, target.column);
  }
  return resolveByRoleAndName(scope, target);
}

function findFrame(page: Page, names: string[]): Root | null {
  let current: Root = page;
  for (const name of names) {
    const child: Frame | undefined = (current === page ? page.mainFrame() : (current as Frame))
      .childFrames()
      .find((f) => f.name() === name);
    if (!child) return null;
    current = child;
  }
  return current;
}

/** Innermost table rows with a direct cell whose whole text matches. */
function rowContaining(root: Root, text: string): Locator {
  return root.locator("tr").filter({
    has: root.locator("xpath=./td | ./th").filter({ hasText: exactText(text) }),
  });
}

async function unique(locator: Locator, what: string): Promise<Resolution> {
  const count = await locator.count();
  if (count === 1) return { ok: true, locator };
  if (count === 0) return { ok: false, error: "element-not-found", detail: `No ${what}` };
  return { ok: false, error: "ambiguous", detail: `${count} matches for ${what}` };
}

async function resolveByRoleAndName(scope: Root | Locator, target: TargetSpec): Promise<Resolution> {
  const what = describeTarget(target);
  const name = target.name ? exactText(target.name) : undefined;

  const byRole = await unique(
    scope.getByRole(target.role as Parameters<Page["getByRole"]>[0], name ? { name } : {}),
    what
  );
  if (byRole.ok || byRole.error === "ambiguous" || !name) return byRole;

  // Legacy markup often lacks the ARIA wiring for role + name: fall back to
  // the visible label of a form field, then to the element's own text.
  if (FORM_ROLES.has(target.role)) {
    const byLabel = await unique(scope.getByLabel(name), what);
    if (byLabel.ok || byLabel.error === "ambiguous") return byLabel;
  }
  return unique(scope.getByText(name), what);
}

/** Key/value tables: the cell right after the cell holding the label. */
async function resolveByLabel(scope: Root | Locator, label: string): Promise<Resolution> {
  const labelCell = await unique(
    scope.locator("td, th").filter({ hasText: exactText(label) }).filter({ hasNot: scope.locator("td, th") }),
    `cell labelled "${label}"`
  );
  if (!labelCell.ok) return labelCell;
  return unique(labelCell.locator.locator("xpath=following-sibling::*[1]"), `value next to "${label}"`);
}

/**
 * The cell of `row` that sits under the header cell named `column`. Only
 * header cells (<th>) count, and a column name that heads more than one
 * column is ambiguous rather than "the first one".
 */
async function resolveColumnCell(row: Locator, column: string): Promise<Resolution> {
  // No named helpers inside evaluate(): some bundlers wrap them in a
  // `__name()` call that does not exist in the page.
  const indices = await row.evaluate((tr, columnText) => {
    const wanted = columnText.replace(/\s+/g, " ").trim().toLowerCase();
    const table = tr.closest("table");
    if (!table) return [];
    const found = new Set<number>();
    for (const r of Array.from(table.rows)) {
      Array.from(r.cells).forEach((c, i) => {
        if (c.tagName === "TH" && (c.textContent ?? "").replace(/\s+/g, " ").trim().toLowerCase() === wanted) {
          found.add(i);
        }
      });
    }
    return Array.from(found);
  }, column);

  if (indices.length === 0) return { ok: false, error: "element-not-found", detail: `No column "${column}"` };
  if (indices.length > 1) return { ok: false, error: "ambiguous", detail: `${indices.length} columns named "${column}"` };
  return unique(row.locator("xpath=./td | ./th").nth(indices[0]), `cell under column "${column}"`);
}
