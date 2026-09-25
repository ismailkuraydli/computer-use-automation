import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { createMockApp } from "../../mock-app/app.js";
import { resolveTarget, exactText } from "./playwright-resolver.js";

const FAST_TIMEOUT_MS = 300;

let server: Server;
let baseUrl: string;
let browser: Browser;
let page: Page;

beforeAll(async () => {
  const mock = createMockApp();
  server = await new Promise<Server>((resolve) => {
    const s = mock.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage();
});

afterAll(async () => {
  await browser.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function textOf(target: Parameters<typeof resolveTarget>[1]): Promise<string> {
  const resolved = await resolveTarget(page, target, FAST_TIMEOUT_MS);
  if (!resolved.ok) throw new Error(`${resolved.error}: ${resolved.detail}`);
  return (await resolved.locator.innerText()).trim();
}

describe("exactText", () => {
  it("matches whole text case-insensitively and ignores extra whitespace", () => {
    expect(exactText("fantasy").test("  Fantasy ")).toBe(true);
    expect(exactText("Member ID").test("Member   ID")).toBe(true);
    expect(exactText("fantasy").test("Science Fiction Fantasy")).toBe(false);
  });
});

describe("resolveTarget on the Keystone mock app", () => {
  it("resolves role + name inside named frames", async () => {
    await page.goto(`${baseUrl}/`);
    expect(await textOf({ role: "link", name: "member search", frame: ["navFrame"] })).toBe("Member Search");
    const input = await resolveTarget(page, { role: "textbox", name: "Member ID", frame: ["mainFrame"] }, FAST_TIMEOUT_MS);
    expect(input.ok).toBe(true);
  });

  it("reports a missing frame as not found", async () => {
    await page.goto(`${baseUrl}/`);
    const result = await resolveTarget(page, { role: "link", name: "Member Search", frame: ["noSuchFrame"] }, FAST_TIMEOUT_MS);
    expect(result).toMatchObject({ ok: false, error: "element-not-found" });
  });

  it("refuses to guess between identical controls", async () => {
    await page.goto(`${baseUrl}/detail?id=12345`);
    const result = await resolveTarget(page, { role: "link", name: "Manage" }, FAST_TIMEOUT_MS);
    expect(result).toMatchObject({ ok: false, error: "ambiguous" });
  });

  it("scopes a repeated control to the row that contains the given cell", async () => {
    await page.goto(`${baseUrl}/detail?id=12345`);
    const resolved = await resolveTarget(page, { role: "link", name: "Manage", row: "savings" }, FAST_TIMEOUT_MS);
    if (!resolved.ok) throw new Error(resolved.detail);
    expect(await resolved.locator.getAttribute("href")).toContain("acct=2003004005");
  });

  it("reads a cell by row and column header", async () => {
    await page.goto(`${baseUrl}/detail?id=23456`);
    expect(await textOf({ role: "cell", row: "Savings", column: "Balance" })).toBe("$8,234.50");
  });

  it("reads the value next to a label in a key/value table", async () => {
    await page.goto(`${baseUrl}/account-action?id=12345&acct=2003004005`);
    expect(await textOf({ role: "cell", label: "Current Balance" })).toBe("$12,847.00");
  });

  it("reports an absent element as not found after polling", async () => {
    await page.goto(`${baseUrl}/search`);
    const result = await resolveTarget(page, { role: "button", name: "Delete Member" }, FAST_TIMEOUT_MS);
    expect(result).toMatchObject({ ok: false, error: "element-not-found" });
  });

  it("ignores data cells that happen to contain the column name", async () => {
    await page.setContent(`<table>
      <tr><th>Type</th><th>Balance</th></tr>
      <tr><td>Balance</td><td>Memo</td></tr>
      <tr><td>Savings</td><td>$100</td></tr>
    </table>`);
    expect(await textOf({ role: "cell", row: "Savings", column: "Balance" })).toBe("$100");
  });

  it("reports a column name used by two headers as ambiguous", async () => {
    await page.setContent(`<table>
      <tr><th>Type</th><th>Balance</th><th>Balance</th></tr>
      <tr><td>Savings</td><td>$100</td><td>$90</td></tr>
    </table>`);
    const result = await resolveTarget(page, { role: "cell", row: "Savings", column: "Balance" }, FAST_TIMEOUT_MS);
    expect(result).toMatchObject({ ok: false, error: "ambiguous" });
  });
});
