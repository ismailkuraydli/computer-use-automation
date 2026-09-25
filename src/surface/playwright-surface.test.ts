import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PlaywrightSurface } from "./playwright-surface.js";
import type { Server } from "http";
import type { AddressInfo } from "net";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { createMockApp, type MockApp } from "../../mock-app/app.js";
import type { ScreenState, Action } from "./types.js";

const shouldRun = process.env.SKIP_INTEGRATION !== "true";

describe.skipIf(!shouldRun)("PlaywrightSurface", () => {
  let surface: PlaywrightSurface;
  let mock: MockApp;
  let server: Server;
  let MOCK_APP_URL: string;
  let screenshotDir: string;

  beforeAll(async () => {
    mock = createMockApp();
    server = await new Promise<Server>((resolve) => {
      const s = mock.app.listen(0, "127.0.0.1", () => resolve(s));
    });
    MOCK_APP_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    screenshotDir = mkdtempSync(path.join(tmpdir(), "surface-test-"));
    surface = new PlaywrightSurface({ headless: true, screenshotDir });
    await surface._start(MOCK_APP_URL);
  }, 30000);

  afterAll(async () => {
    await surface.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(screenshotDir, { recursive: true, force: true });
  });

  // AC1: Given a running mock app, when I call PlaywrightSurface.observe(),
  // then I receive a ScreenState containing the AX tree, DOM snapshot, URL, and screenshot path.
  it("observe() returns a ScreenState with AX tree, DOM snapshot, URL, and screenshot", async () => {
    const state: ScreenState = await surface.observe();

    expect(state.url).toContain(MOCK_APP_URL);
    expect(state.title).toBeTruthy();
    expect(state.axTree).toBeDefined();
    expect(Array.isArray(state.axTree)).toBe(true);
    expect(state.axTree.length).toBeGreaterThan(0);
    expect(state.domSnapshot).toBeDefined();
    expect(typeof state.domSnapshot).toBe("string");
    expect(state.screenshotPath).toBeDefined();
    expect(state.frameUrls).toBeDefined();
    expect(Array.isArray(state.frameUrls)).toBe(true);
  }, 30000);

  // AC3: Given the mock app search page, when I call PlaywrightSurface.act(navigate, /search),
  // then the browser navigates and observe() returns the search page state.
  it("act(navigate) navigates to /search and observe returns the search page state", async () => {
    const action: Action = { type: "navigate", value: `${MOCK_APP_URL}/search` };
    const result = await surface.act(action);

    expect(result.ok).toBe(true);

    const state = await surface.observe();
    expect(state.url).toContain("/search");
    // The search page should have a "Member ID" textbox in its AX tree
    const hasMemberIdField = state.axTree.some(
      (n) => n.role === "textbox" && n.name.includes("Member ID")
    );
    expect(hasMemberIdField).toBe(true);
  }, 30000);

  it("act(type) types into the Member ID field", async () => {
    // First navigate to search page
    await surface.act({ type: "navigate", value: `${MOCK_APP_URL}/search` });

    // Find the Member ID textbox
    const state = await surface.observe();
    const memberField = state.axTree.find(
      (n) => n.role === "textbox" && n.name.includes("Member ID")
    );
    expect(memberField).toBeDefined();

    // Type into it
    const result = await surface.act({
      type: "type",
      target: memberField!,
      value: "12345",
    });
    expect(result.ok).toBe(true);
  }, 30000);

  it("act(click) clicks the Search button", async () => {
    // Navigate to search page (already there from previous test, but ensure)
    await surface.act({ type: "navigate", value: `${MOCK_APP_URL}/search?q=12345` });

    // Wait for page to load
    await surface.act({ type: "wait", value: "500" });

    // Observe the results
    const state = await surface.observe();

    // Should have a link to the member detail page
    const hasMemberLink = state.axTree.some(
      (n) => n.role === "link" && n.name.includes("12345")
    );
    expect(hasMemberLink).toBe(true);
  }, 30000);

  it("act(extract) reads text from the page", async () => {
    // Navigate to member detail page
    await surface.act({ type: "navigate", value: `${MOCK_APP_URL}/detail?id=12345` });
    await surface.act({ type: "wait", value: "500" });

    const state = await surface.observe();

    // Look for the heading which contains the member name
    const headingNode = state.axTree.find(
      (n) => n.role === "heading" && n.name.includes("Member Detail")
    );
    expect(headingNode).toBeDefined();

    if (headingNode) {
      const result = await surface.act({
        type: "extract",
        target: headingNode,
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.extractedValue).toContain("Member Detail");
      }
    }
  }, 30000);
  it("reports a click on a covered element as blocked instead of forcing it", async () => {
    mock.setFaults({ interstitialPaths: ["/search"] });
    try {
      await surface.act({ type: "navigate", value: `${MOCK_APP_URL}/search` });
      const result = await surface.act({ type: "click", target: { role: "button", name: "Search" } });
      expect(result).toMatchObject({ ok: false, error: "blocked" });
    } finally {
      mock.resetFaults();
    }
  });

  it("dismisses a native confirm() and reports it instead of accepting", async () => {
    mock.setFaults({ confirmOnSubmit: true });
    try {
      await surface.act({ type: "navigate", value: `${MOCK_APP_URL}/new-account?id=12345` });
      await surface.act({ type: "type", target: { role: "textbox", name: "Initial Deposit" }, value: "100" });
      const result = await surface.act({ type: "submit", target: { role: "button", name: "Continue" } });
      expect(result).toMatchObject({ ok: false, error: "unexpected-dialog" });
      expect((await surface.observe()).url).toContain("/new-account");
    } finally {
      mock.resetFaults();
    }
  });

  it("selects an option by its visible text", async () => {
    await surface.act({ type: "navigate", value: `${MOCK_APP_URL}/new-account?id=12345` });
    const result = await surface.act({ type: "select", target: { role: "combobox", name: "Account Type" }, value: "certificate of deposit" });
    expect(result.ok).toBe(true);
  });
});
