import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PlaywrightSurface } from "../surface/playwright-surface.js";
import { resolveLocator } from "./locator-strategy.js";
import type { LocatorSpec } from "./types.js";

// AC4: Given a hostile surface with iframes and table layouts, when I run the
// locator spike against 5 target elements across 2 iframes, then all 5 elements
// are resolved via AX-tree locators and the resolution is stable across 3 page reloads.

const MOCK_APP_URL = "http://localhost:3000";

describe.skipIf(process.env.SKIP_INTEGRATION === "true")("Locator Spike", () => {
  let surface: PlaywrightSurface;

  beforeAll(async () => {
    surface = new PlaywrightSurface({ headless: true, screenshotDir: "./screenshots" });
    await surface._start(MOCK_APP_URL);
  }, 30000);

  afterAll(async () => {
    await surface.close();
  });

  // 5 target elements across 2 frames:
  // 1. Main frame: h1 heading "Keystone Credit Union - Member Servicing Portal"
  // 2. navFrame: link "Member Search"
  // 3. navFrame: link "New Account Demo"
  // 4. mainFrame: textbox "Member ID"
  // 5. mainFrame: button "Search"
  const targets: LocatorSpec[] = [
    {
      primary: { role: "heading", name: "Keystone Credit Union - Member Servicing Portal" },
      framePath: [],
    },
    {
      primary: { role: "link", name: "Member Search" },
      framePath: ["navFrame"],
    },
    {
      primary: { role: "link", name: "New Account Demo" },
      framePath: ["navFrame"],
    },
    {
      primary: { role: "textbox", name: "Member ID" },
      framePath: ["mainFrame"],
    },
    {
      primary: { role: "button", name: "Search" },
      framePath: ["mainFrame"],
    },
  ];

  it("resolves all 5 target elements via AX-tree locators", async () => {
    const state = await surface.observe();

    for (let i = 0; i < targets.length; i++) {
      const result = resolveLocator(targets[i], state.axTree);
      expect(result.ok, `Target ${i + 1} (${targets[i].primary.role} "${targets[i].primary.name}" in ${targets[i].framePath?.join("/") || "main frame"})`).toBe(true);
      if (result.ok) {
        expect(result.node.role).toBe(targets[i].primary.role);
        expect(result.node.name).toBe(targets[i].primary.name);
      }
    }
  }, 30000);

  it("locator resolution is stable across 3 page reloads", async () => {
    for (let reload = 0; reload < 3; reload++) {
      // Reload the page
      await surface.act({ type: "navigate", value: MOCK_APP_URL });
      await surface.act({ type: "wait", value: "1000" }); // Wait for iframes to load

      const state = await surface.observe();

      for (let i = 0; i < targets.length; i++) {
        const result = resolveLocator(targets[i], state.axTree);
        expect(
          result.ok,
          `Reload ${reload + 1}, Target ${i + 1} (${targets[i].primary.role} "${targets[i].primary.name}" in ${targets[i].framePath?.join("/") || "main frame"})`
        ).toBe(true);
      }
    }
  }, 60000);
});
