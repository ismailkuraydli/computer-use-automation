/**
 * PlaywrightSurface — implements the Surface interface using Playwright.
 *
 * Per ADR-008: this is the concrete implementation. The Surface interface
 * (types.ts) is the seam. No Playwright types should leak through the interface.
 *
 * Per ADR-003: AX-tree-first. Since page.accessibility.snapshot() was removed in
 * Playwright 1.63 and CDP's Accessibility.getFullAXTree doesn't traverse iframes,
 * we build the AX tree by running JavaScript in each frame that extracts
 * role+name from aria-label, role attributes, and implicit semantics.
 * Element interaction uses Playwright's native getByRole() which uses the
 * browser's real AX tree.
 */

import { chromium, type Browser, type Page, type Frame } from "playwright";
import type {
  Surface,
  ScreenState,
  Action,
  ActionResult,
  AXNode,
} from "./types.js";
import path from "path";
import { randomUUID } from "crypto";

export interface PlaywrightSurfaceOptions {
  headless?: boolean;
  screenshotDir?: string;
  remoteDebuggingPort?: number;
}

// JavaScript that runs in the browser to build an AX-like tree
// from aria-label, role attributes, and implicit semantics.
// Wrapped as an IIFE so page.evaluate() executes it immediately.
const BUILD_AX_TREE_JS = `(() => {
  function getImplicitRole(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    const implicit = {
      'a': 'link',
      'button': 'button',
      'input': type === 'submit' || type === 'button' || type === 'reset' ? 'button' : 'textbox',
      'select': 'combobox',
      'textarea': 'textbox',
      'img': 'image',
      'table': 'table',
      'th': 'columnheader',
      'td': 'cell',
      'tr': 'row',
      'ul': 'list',
      'ol': 'list',
      'li': 'listitem',
      'h1': 'heading', 'h2': 'heading', 'h3': 'heading',
      'h4': 'heading', 'h5': 'heading', 'h6': 'heading',
      'label': 'label',
      'form': 'form',
      'nav': 'navigation',
      'main': 'main',
    };
    return implicit[tag] || null;
  }

  function getAccessibleName(el) {
    // aria-label takes precedence
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    // aria-labelledby
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const labelEl = document.getElementById(labelledby);
      if (labelEl) return labelEl.textContent.trim();
    }
    // <label for="id"> association
    if (el.id) {
      const label = document.querySelector('label[for="' + el.id + '"]');
      if (label) return label.textContent.trim();
    }
    // Wrapping <label>
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      const parent = el.closest('label');
      if (parent) return parent.textContent.trim();
    }
    // For buttons and links: text content
    if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button')) {
      return (el.textContent || el.value || '').trim();
    }
    // For headings: text content
    if (/^H[1-6]$/.test(el.tagName)) {
      return (el.textContent || '').trim();
    }
    // For cells: text content (first 100 chars)
    if (el.tagName === 'TD' || el.tagName === 'TH') {
      const text = (el.textContent || '').trim();
      return text.length > 0 ? text.substring(0, 100) : '';
    }
    // For label elements: text content
    if (el.tagName === 'LABEL') {
      return (el.textContent || '').trim();
    }
    // For elements with role attribute (e.g. div role="button"): use text content
    // if it's short enough to be a label (< 80 chars) and the element is visible
    if (el.getAttribute('role') && el.offsetParent !== null) {
      const text = (el.textContent || '').trim();
      if (text.length > 0 && text.length <= 80) {
        return text;
      }
    }
    // For span elements with short text inside a form/fieldset (settings, options)
    if (el.tagName === 'SPAN' && el.offsetParent !== null) {
      const text = (el.textContent || '').trim();
      if (text.length > 0 && text.length <= 40) {
        // Only include if parent is a label, form, or has a role
        const parent = el.parentElement;
        if (parent && (parent.tagName === 'LABEL' || parent.tagName === 'FORM' || parent.getAttribute('role'))) {
          return text;
        }
      }
    }
    return '';
  }

  const result = [];
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
  const seen = new Set();
  while (walker.nextNode()) {
    const el = walker.currentNode;
    if (seen.has(el)) continue;
    seen.add(el);
    const role = el.getAttribute('role') || getImplicitRole(el);
    if (!role) continue;
    const name = getAccessibleName(el);
    if (!name || name.length === 0) continue;
    // Skip layout-only roles
    if (role === 'none' || role === 'presentation' || role === 'LayoutTable' || role === 'LayoutTableRow' || role === 'LayoutTableCell') continue;
    result.push({
      role: role,
      name: name.substring(0, 200),
      value: (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') ? (el.value || '') : undefined,
      children: [],
    });
  }
  return result;
})()`;

export class PlaywrightSurface implements Surface {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private screenshotDir: string;
  private headless: boolean;
  private remoteDebuggingPort?: number;

  constructor(options: PlaywrightSurfaceOptions = {}) {
    this.headless = options.headless ?? true;
    this.screenshotDir = options.screenshotDir ?? "./screenshots";
    this.remoteDebuggingPort = options.remoteDebuggingPort;
  }

  async _start(url?: string): Promise<void> {
    const launchOptions: Record<string, unknown> = {
      headless: this.headless,
    };
    if (this.remoteDebuggingPort) {
      launchOptions.args = [`--remote-debugging-port=${this.remoteDebuggingPort}`];
    }

    this.browser = await chromium.launch(launchOptions);
    this.page = await this.browser.newPage({ viewport: { width: 1280, height: 720 } });

    if (url) {
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    }
  }

  async observe(): Promise<ScreenState> {
    if (!this.page) throw new Error("Surface not started — call _start() first");

    const url = this.page.url();
    const title = await this.page.title();

    // Build unified AX tree across all frames
    const axTree = await this._buildUnifiedAXTree();
    const frameUrls = this.page.frames().map((f) => f.url());

    // DOM snapshot (simplified — just the body HTML)
    const domSnapshot = await this.page.evaluate(() => {
      return document.body ? document.body.innerHTML.substring(0, 50000) : "";
    });

    // Screenshot
    const screenshotPath = path.join(this.screenshotDir, `screen-${randomUUID().slice(0, 8)}.png`);
    try {
      await this.page.screenshot({ path: screenshotPath, fullPage: false });
    } catch {
      // Screenshot may fail if page is navigating — that's OK
    }

    return {
      url,
      title,
      axTree,
      domSnapshot,
      screenshotPath,
      frameUrls,
    };
  }

  async act(action: Action): Promise<ActionResult> {
    if (!this.page) throw new Error("Surface not started — call _start() first");

    switch (action.type) {
      case "navigate":
        if (!action.value) return { ok: false, error: "navigate requires a URL" };
        return this._navigate(action.value);

      case "click":
        if (!action.target) return { ok: false, error: "click requires a target" };
        return this._click(action.target);

      case "type":
        if (!action.target) return { ok: false, error: "type requires a target" };
        if (action.value === undefined) return { ok: false, error: "type requires a value" };
        return this._type(action.target, action.value);

      case "extract":
        if (!action.target) return { ok: false, error: "extract requires a target" };
        return this._extract(action.target);

      case "submit":
        if (!action.target) return { ok: false, error: "submit requires a target" };
        return this._click(action.target);

      case "wait":
        return this._wait(action.value ? parseInt(action.value, 10) : 1000);

      default:
        return { ok: false, error: `Unknown action type: ${action.type}` };
    }
  }

  async navigate(url: string): Promise<ActionResult> {
    return this._navigate(url);
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }

  async exposeSession(): Promise<{ endpoint: string; token: string }> {
    const port = this.remoteDebuggingPort ?? 9222;
    return {
      endpoint: `http://localhost:${port}`,
      token: randomUUID(),
    };
  }

  // --- Private implementation ---

  private async _navigate(url: string): Promise<ActionResult> {
    if (!this.page) throw new Error("Surface not started");
    try {
      await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: "navigation-failed", detail: String(e) };
    }
  }

  private async _click(target: AXNode): Promise<ActionResult> {
    if (!this.page) throw new Error("Surface not started");
    try {
      const locator = await this._findElementByAX(target);
      if (!locator) {
        return { ok: false, error: "element-not-found", detail: `Could not find ${target.role} "${target.name}"` };
      }
      await locator.click({ timeout: 5000 });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: "click-failed", detail: String(e) };
    }
  }

  private async _type(target: AXNode, value: string): Promise<ActionResult> {
    if (!this.page) throw new Error("Surface not started");
    try {
      const locator = await this._findElementByAX(target);
      if (!locator) {
        return { ok: false, error: "element-not-found", detail: `Could not find ${target.role} "${target.name}"` };
      }
      await locator.fill(value, { timeout: 5000 });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: "type-failed", detail: String(e) };
    }
  }

  private async _extract(target: AXNode): Promise<ActionResult> {
    if (!this.page) throw new Error("Surface not started");
    try {
      const locator = await this._findElementByAX(target);
      if (!locator) {
        return { ok: false, error: "element-not-found", detail: `Could not find ${target.role} "${target.name}"` };
      }
      const text = await locator.textContent({ timeout: 5000 });
      return { ok: true, extractedValue: text?.trim() ?? "" };
    } catch (e) {
      return { ok: false, error: "extract-failed", detail: String(e) };
    }
  }

  private async _wait(ms: number): Promise<ActionResult> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { ok: true };
  }

  /**
   * Find an element by AX role and name using Playwright's native getByRole.
   * Searches the appropriate frame based on the target's framePath.
   */
  private async _findElementByAX(target: AXNode): Promise<ReturnType<Page["locator"]> | null> {
    if (!this.page) return null;

    // Determine which frame to search in
    let frame: Page | Frame = this.page;
    const framePath = target.framePath || [];
    if (framePath.length > 0 && this.page) {
      const allFrames = this.page.frames();
      for (const frameName of framePath) {
        const childFrame = allFrames.find((f: Frame) => f.name() === frameName);
        if (childFrame) {
          frame = childFrame;
        }
      }
    }

    // Use Playwright's native getByRole (uses the browser's real AX tree)
    try {
      const locator = frame.getByRole(target.role as any, { name: target.name, exact: true });
      const count = await locator.count();
      if (count > 0) {
        return locator.first();
      }
    } catch {
      // getByRole may fail for non-standard roles — fall through to fallbacks
    }

    // Fallback: try getByLabel for textboxes
    try {
      if (target.role === "textbox" || target.role === "combobox" || target.role === "searchbox") {
        const labelLocator = frame.getByLabel(target.name, { exact: true });
        const count = await labelLocator.count();
        if (count > 0) return labelLocator.first();
      }
      // Try getByText for buttons, links, and labels
      if (target.role === "button" || target.role === "link" || target.role === "label") {
        const textLocator = frame.getByText(target.name, { exact: true });
        const count = await textLocator.count();
        if (count > 0) return textLocator.first();
      }
      // Try getByRole with partial name match
      const locator = frame.getByRole(target.role as any, { name: target.name });
      const count = await locator.count();
      if (count > 0) return locator.first();
    } catch {
      // ignore
    }

    // Last resort: try getByText for any role (settings labels, spans, etc.)
    try {
      const textLocator = frame.getByText(target.name, { exact: true });
      const count = await textLocator.count();
      if (count > 0) return textLocator.first();
    } catch {
      // ignore
    }

    return null;
  }

  /**
   * Build a unified AX tree across all frames on the page.
   * Uses JavaScript evaluation in each frame to extract AX-like data.
   */
  private async _buildUnifiedAXTree(): Promise<AXNode[]> {
    if (!this.page) return [];

    const result: AXNode[] = [];

    // Get AX tree for the main frame
    try {
      const mainNodes = await this.page.evaluate(BUILD_AX_TREE_JS) as any[];
      result.push(...mainNodes.map((n) => ({ ...n, framePath: [] as string[] })));
    } catch {
      // Page may not be ready — return empty
    }

    // Get AX tree for all child frames
    const allFrames = this.page.frames();
    for (const frame of allFrames) {
      if (frame === this.page.mainFrame()) continue;
      const frameName = frame.name() || `frame-${allFrames.indexOf(frame)}`;
      try {
        const frameNodes = await frame.evaluate(BUILD_AX_TREE_JS) as any[];
        result.push(...frameNodes.map((n) => ({ ...n, framePath: [frameName] })));
      } catch {
        // Frame may not be accessible — skip it
      }
    }

    return result;
  }
}
