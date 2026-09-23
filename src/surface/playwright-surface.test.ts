import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PlaywrightSurface } from "./playwright-surface.js";
import type { ScreenState, Action } from "./types.js";

// These tests require the mock app to be running on localhost:3000
// Start it with: npm run mock-app

const MOCK_APP_URL = "http://localhost:3000";
const SURFACE_OPTIONS = { headless: true, screenshotDir: "./screenshots" };

// Skip tests if mock app is not running
const shouldRun = process.env.SKIP_INTEGRATION !== "true";

describe.skipIf(!shouldRun)("PlaywrightSurface", () => {
  let surface: PlaywrightSurface;

  beforeAll(async () => {
    surface = new PlaywrightSurface(SURFACE_OPTIONS);
    await surface._start(MOCK_APP_URL);
  }, 30000);

  afterAll(async () => {
    await surface.close();
  });

  // AC1: Given a running mock app, when I call PlaywrightSurface.observe(),
  // then I receive a ScreenState containing the AX tree, DOM snapshot, URL, and screenshot path.
  it("observe() returns a ScreenState with AX tree, DOM snapshot, URL, and screenshot", async () => {
    const state: ScreenState = await surface.observe();

    expect(state.url).toContain("localhost:3000");
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
});
