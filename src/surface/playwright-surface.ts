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

/** How long an action waits for its element to become actionable. */
const ACTION_TIMEOUT_MS = 5000;

/**
 * Map a Playwright action error to a surface error code. "blocked" means
 * another element covers the target (overlay, modal) — the caller decides
 * whether that is a known interstitial or something a human must look at.
 */
function actionFailure(e: unknown): ActionResult {
  const message = e instanceof Error ? e.message : String(e);
  const interceptor = message.match(/(<[^\n]*?>)[^\n]*? intercepts pointer events/);
  if (interceptor) {
    return { ok: false, error: "blocked", detail: `Target is covered by ${interceptor[1]}` };
  }
  return { ok: false, error: "not-actionable", detail: message.split("\n")[0] };
}

export interface PlaywrightSurfaceOptions {
  headless?: boolean;
  screenshotDir?: string;
  remoteDebuggingPort?: number;
}

// JavaScript that runs in the browser to build an AX-like tree
// from aria-label, role attributes, and implicit semantics.
// Also captures exact element identity (CSS selector, id, aria-label, text, href)
// so the Recorder can store it in the artifact for precise replay.
// Wrapped as an IIFE so page.evaluate() executes it immediately.
const BUILD_AX_TREE_JS = `(() => {
  function getImplicitRole(el) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    // Input elements: role depends on type attribute
    if (tag === 'input') {
      if (type === 'submit' || type === 'button' || type === 'reset') return 'button';
      if (type === 'radio') return 'radio';
      if (type === 'checkbox') return 'checkbox';
      if (type === 'range') return 'slider';
      if (type === 'search') return 'searchbox';
      return 'textbox';
    }
    const implicit = {
      'a': 'link',
      'button': 'button',
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
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label');
    const labelledby = el.getAttribute('aria-labelledby');
    if (labelledby) {
      const labelEl = document.getElementById(labelledby);
      if (labelEl) return labelEl.textContent.trim();
    }
    if (el.id) {
      const label = document.querySelector('label[for="' + el.id + '"]');
      if (label) return label.textContent.trim();
    }
    if (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') {
      const parent = el.closest('label');
      if (parent) return parent.textContent.trim();
    }
    if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.tagName === 'INPUT' && (el.type === 'submit' || el.type === 'button')) {
      return (el.textContent || el.value || '').trim();
    }
    if (/^H[1-6]$/.test(el.tagName)) {
      return (el.textContent || '').trim();
    }
    if (el.tagName === 'TD' || el.tagName === 'TH') {
      const text = (el.textContent || '').trim();
      return text.length > 0 ? text.substring(0, 100) : '';
    }
    if (el.tagName === 'LABEL') {
      return (el.textContent || '').trim();
    }
    if (el.getAttribute('role') && el.offsetParent !== null) {
      const text = (el.textContent || '').trim();
      if (text.length > 0 && text.length <= 80) {
        return text;
      }
    }
    if (el.tagName === 'SPAN' && el.offsetParent !== null) {
      const text = (el.textContent || '').trim();
      if (text.length > 0 && text.length <= 40) {
        const parent = el.parentElement;
        if (parent && (parent.tagName === 'LABEL' || parent.tagName === 'FORM' || parent.getAttribute('role'))) {
          return text;
        }
      }
    }
    return '';
  }

  function getCssSelector(el) {
    // If element has an id, use it (most reliable)
    if (el.id) return '#' + CSS.escape(el.id);

    // Build a path from tag, classes, and nth-child
    var parts = [];
    var current = el;
    var depth = 0;
    while (current && current !== document.body && depth < 10) {
      var part = current.tagName.toLowerCase();
      // Add classes for specificity
      if (current.className && typeof current.className === 'string') {
        var classes = current.className.trim().split(/\\s+/).filter(function(c) { return c.length > 0; });
        if (classes.length > 0) {
          part += '.' + classes.slice(0, 2).map(function(c) { return CSS.escape(c); }).join('.');
        }
      }
      // Add aria-label if present (very specific)
      if (current.getAttribute('aria-label')) {
        part += '[aria-label="' + CSS.escape(current.getAttribute('aria-label')) + '"]';
      }
      // Add nth-child for disambiguation
      var parent = current.parentElement;
      if (parent) {
        var siblings = Array.from(parent.children).filter(function(s) { return s.tagName === current.tagName; });
        if (siblings.length > 1) {
          var idx = siblings.indexOf(current) + 1;
          part += ':nth-of-type(' + idx + ')';
        }
      }
      parts.unshift(part);
      current = current.parentElement;
      depth++;
    }
    return parts.join(' > ');
  }

  var result = [];
  var walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_ELEMENT);
  var seen = new Set();
  while (walker.nextNode()) {
    var el = walker.currentNode;
    if (seen.has(el)) continue;
    seen.add(el);
    var role = el.getAttribute('role') || getImplicitRole(el);
    if (!role) continue;
    var name = getAccessibleName(el);
    // For structural elements (main, article, section, region), allow empty
    // names — they're used for extraction targets and can be found by role alone
    var allowEmptyName = (role === 'main' || role === 'article' || role === 'region' || role === 'contentinfo' || role === 'document');
    if (!name || name.length === 0) {
      if (!allowEmptyName) continue;
    }
    if (role === 'none' || role === 'presentation' || role === 'LayoutTable' || role === 'LayoutTableRow' || role === 'LayoutTableCell') continue;
    result.push({
      role: role,
      name: name.substring(0, 200),
      value: (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA') ? (el.value || '') : undefined,
      children: [],
      cssSelector: getCssSelector(el),
      id: el.id || undefined,
      ariaLabel: el.getAttribute('aria-label') || undefined,
      text: ((el.textContent || '').trim()).substring(0, 100),
      href: el.tagName === 'A' ? (el.getAttribute('href') || undefined) : undefined,
      dataTestId: el.getAttribute('data-testid') || el.getAttribute('data-test-id') || undefined,
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

      case "scroll":
        return this._scroll(action.value || "down");

      case "read_page_text":
        return this._readPageText();

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
      // Wait for network activity to settle — dynamic content (settings panels,
      // SPA widgets, lazy-loaded elements) may not be in the DOM at domcontentloaded.
      await this.page.waitForLoadState("networkidle", { timeout: 10000 }).catch(() => {});
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
      // Playwright waits until the element is visible, stable, enabled and
      // actually receives the click. Never force it: a forced click lands on
      // whatever sits on top (an overlay, a dialog button) and reports success.
      await locator.click({ timeout: ACTION_TIMEOUT_MS });
      return { ok: true };
    } catch (e) {
      return actionFailure(e);
    }
  }

  private async _type(target: AXNode, value: string): Promise<ActionResult> {
    if (!this.page) throw new Error("Surface not started");
    try {
      const locator = await this._findElementByAX(target);
      if (!locator) {
        return { ok: false, error: "element-not-found", detail: `Could not find ${target.role} "${target.name}"` };
      }
      await locator.fill(value, { timeout: ACTION_TIMEOUT_MS });
      return { ok: true };
    } catch (e) {
      return actionFailure(e);
    }
  }

  private async _extract(target: AXNode): Promise<ActionResult> {
    if (!this.page) throw new Error("Surface not started");
    try {
      const locator = await this._findElementByAX(target);
      if (!locator) {
        return { ok: false, error: "element-not-found", detail: `Could not find ${target.role} "${target.name}"` };
      }
      // Try textContent first
      let text = await locator.textContent({ timeout: 5000 });
      text = text?.trim() ?? "";

      // If empty (e.g. link wrapping an image), try innerText, then aria-label, then alt text
      if (!text) {
        try {
          text = await locator.innerText({ timeout: 3000 });
          text = text.trim();
        } catch { /* not visible */ }
      }
      if (!text) {
        // Try aria-label attribute
        try {
          const ariaLabel = await locator.getAttribute("aria-label", { timeout: 3000 });
          if (ariaLabel) text = ariaLabel.trim();
        } catch { /* ignore */ }
      }
      if (!text) {
        // Try alt text from child images
        try {
          const alt = await locator.locator("img").first().getAttribute("alt", { timeout: 3000 });
          if (alt) text = alt.trim();
        } catch { /* no img */ }
      }
      // If still empty, use the target name from the AX tree (it was found by name, so it has one)
      if (!text && target.name) {
        text = target.name;
      }

      return { ok: true, extractedValue: text };
    } catch (e) {
      return { ok: false, error: "extract-failed", detail: String(e) };
    }
  }

  private async _wait(ms: number): Promise<ActionResult> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return { ok: true };
  }

  private async _scroll(direction: string): Promise<ActionResult> {
    if (!this.page) throw new Error("Surface not started");
    try {
      const delta = direction === "up" ? -720 : 720;
      await this.page.mouse.wheel(0, delta);
      await this.page.waitForTimeout(500); // Let content load after scroll
      return { ok: true };
    } catch (e) {
      return { ok: false, error: "scroll-failed", detail: String(e) };
    }
  }

  private async _readPageText(): Promise<ActionResult> {
    if (!this.page) throw new Error("Surface not started");
    try {
      const text = await this.page.evaluate(() => {
        // Get all visible text content, limited to a reasonable size
        const body = document.body;
        if (!body) return "";
        // Use innerText to get only visible text (not hidden, not script/style)
        const text = body.innerText || "";
        // Limit to first 5000 chars to avoid overwhelming the LLM
        return text.substring(0, 5000);
      });
      return { ok: true, extractedValue: text };
    } catch (e) {
      return { ok: false, error: "read-page-text-failed", detail: String(e) };
    }
  }

  /**
   * Find an element on the page using the identity fields captured during
   * discovery. Resolution order:
   *   1. CSS selector (if recorded — most specific, like a Playwright test selector)
   *   2. id (if recorded)
   *   3. data-testid (if recorded)
   *   4. Role + name via getByRole (exact match)
   *   5. Role + name via getByRole (partial match — handles param-substituted
   *      names where the actual page text differs, e.g. "More {{genre}} books..."
   *      on a page that says "More horror books...")
   *   6. Text content via getByText (for non-standard roles: labels, spans)
   *
   * If the name contains {{param}} templates, they are stripped and the
   * remaining key words are used for partial matching. This handles replay
   * with different params where the page text doesn't match the substituted name.
   *
   * Retries once after 1 second for dynamically loaded content.
   */
  private async _findElementByAX(target: AXNode): Promise<ReturnType<Page["locator"]> | null> {
    if (!this.page) return null;

    const result = await this._tryFindElement(target);
    if (result) return result;

    // Wait and retry for dynamically loaded content
    await new Promise((resolve) => setTimeout(resolve, 1000));
    return this._tryFindElement(target);
  }

  /**
   * Build a "search name" from the target name: strip {{param}} templates
   * and return the remaining text. If the name is entirely a template
   * (e.g. "{{topic}}"), return the original name (it will be substituted
   * by the replay engine before reaching here).
   */
  private _searchName(name: string): string {
    const stripped = name.replace(/\{\{[^}]+\}\}/g, "").trim();
    // If stripping removed everything, keep original (replay engine substitutes it)
    return stripped.length >= 3 ? stripped : name;
  }

  /** Anchored, case-insensitive pattern matching the whole name. */
  private _exactNamePattern(name: string): RegExp {
    const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`^\\s*${escaped}\\s*$`, "i");
  }

  private async _tryFindElement(target: AXNode): Promise<ReturnType<Page["locator"]> | null> {
    if (!this.page) return null;

    // Determine which frame to search in
    let frame: Page | Frame = this.page;
    const framePath = target.framePath || [];
    if (framePath.length > 0 && this.page) {
      const allFrames = this.page.frames();
      for (const frameName of framePath) {
        const childFrame = allFrames.find((f: Frame) => f.name() === frameName);
        if (childFrame) frame = childFrame;
      }
    }

    // If the target name still contains an unsubstituted {{param}} template,
    // the CSS selector and id point to the discovery element. Skip them.
    // (The replay engine also strips cssSelector/id when the original name
    // had a template, but this catches cases where the surface is called
    // directly during discovery.)
    const hasParamTemplate = /\{\{[^}]+\}\}/.test(target.name);
    const searchName = this._searchName(target.name);

    // 1. CSS selector (most specific) — skip if name has {{param}} (wrong element)
    if (target.cssSelector && !hasParamTemplate) {
      try {
        const locator = frame.locator(target.cssSelector);
        if (await locator.count() > 0) return locator.first();
      } catch { /* invalid or not found */ }
    }

    // 2. id — skip if name has {{param}} (wrong element)
    if (target.id && !hasParamTemplate) {
      try {
        const escapedId = target.id.replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
        const locator = frame.locator(`#${escapedId}`);
        if (await locator.count() > 0) return locator.first();
      } catch { /* not found */ }
    }

    // 3. data-testid — always safe (test IDs are param-independent)
    if (target.dataTestId) {
      try {
        const locator = frame.getByTestId(target.dataTestId);
        if (await locator.count() > 0) return locator.first();
      } catch { /* not found */ }
    }

    // 4. getByRole with full-name match, case-insensitive (user may pass
    //    "fantasy" when the page says "Fantasy")
    const exactName = this._exactNamePattern(target.name);
    try {
      const locator = frame.getByRole(target.role as any, { name: exactName });
      if (await locator.count() > 0) return locator.first();
    } catch { /* non-standard role */ }

    // 5. getByRole with partial name match (handles param-substituted names)
    if (searchName !== target.name) {
      try {
        const locator = frame.getByRole(target.role as any, { name: searchName });
        if (await locator.count() > 0) return locator.first();
      } catch { /* not found */ }
    }

    // 6. getByText (for non-standard roles: labels, spans, settings text)
    try {
      // Exact match first
      const exactLocator = frame.getByText(exactName);
      if (await exactLocator.count() > 0) return exactLocator.first();

      // Partial match with stripped name
      if (searchName !== target.name) {
        const partialLocator = frame.getByText(searchName);
        if (await partialLocator.count() > 0) return partialLocator.first();
      }

      // getByLabel for form fields
      if (target.role === "textbox" || target.role === "combobox" || target.role === "searchbox") {
        const labelLocator = frame.getByLabel(target.name, { exact: true });
        if (await labelLocator.count() > 0) return labelLocator.first();
      }
    } catch { /* not found */ }

    return null;
  }

  /**
   * Build a unified AX tree across all frames on the page.
   * Per ADR-011: CDP Accessibility.getFullAXTree for main frame (browser's real AX tree),
   * JS builder fallback for iframe content. Also supplements CDP with JS-scanned
   * label/span elements that CDP doesn't expose (e.g. Wikipedia settings).
   */
  private async _buildUnifiedAXTree(): Promise<AXNode[]> {
    if (!this.page) return [];

    const result: AXNode[] = [];

    // --- Main frame: use CDP Accessibility.getFullAXTree (browser's real AX tree) ---
    let cdpSuccess = false;
    try {
      const cdp = await this.page.context().newCDPSession(this.page);
      const cdpResult = await cdp.send("Accessibility.getFullAXTree");
      if (cdpResult.nodes && cdpResult.nodes.length > 0) {
        const cdpNodes = this._convertCDPAXTree(cdpResult.nodes);
        result.push(...cdpNodes.map((n) => ({ ...n, framePath: [] as string[] })));
        cdpSuccess = true;
      }
    } catch {
      // CDP may not be available
    }

    // --- Supplement with JS scan to add identity fields and missing elements ---
    // CDP's AX tree doesn't expose label/span elements without aria-label or
    // explicit role attributes, and CDP nodes don't have CSS selectors.
    // We run the JS builder to:
    // 1. Add CSS selectors, id, ariaLabel, text, href, dataTestId to existing CDP nodes
    // 2. Add missing label/span/div elements that CDP doesn't expose
    try {
      const supplementNodes = await this.page.evaluate(BUILD_AX_TREE_JS) as any[];
      // Track which CDP nodes have already been merged (by index) to handle
      // duplicate role:name pairs correctly (e.g. two "radio:Standard" elements)
      const mergedCdpIndices = new Set<number>();
      for (const node of supplementNodes) {
        // Find the first CDP node that matches by role:name and hasn't been merged yet
        let matchIdx = -1;
        for (let i = 0; i < result.length; i++) {
          if (mergedCdpIndices.has(i)) continue;
          if (result[i].role === node.role && result[i].name === node.name) {
            matchIdx = i;
            break;
          }
        }
        if (matchIdx >= 0) {
          // Merge identity fields into existing CDP node
          const existing = result[matchIdx];
          mergedCdpIndices.add(matchIdx);
          if (node.cssSelector && !existing.cssSelector) existing.cssSelector = node.cssSelector;
          if (node.id && !existing.id) existing.id = node.id;
          if (node.ariaLabel && !existing.ariaLabel) existing.ariaLabel = node.ariaLabel;
          if (node.text && !existing.text) existing.text = node.text;
          if (node.href && !existing.href) existing.href = node.href;
          if (node.dataTestId && !existing.dataTestId) existing.dataTestId = node.dataTestId;
        } else {
          // New element not in CDP tree — add it
          result.push({ ...node, framePath: [] as string[] });
        }
      }
    } catch {
      // If CDP also failed and JS fails too, return whatever we have
      if (!cdpSuccess) {
        try {
          const mainNodes = await this.page.evaluate(BUILD_AX_TREE_JS) as any[];
          result.push(...mainNodes.map((n) => ({ ...n, framePath: [] as string[] })));
        } catch {
          // Page not ready
        }
      }
    }

    // --- Child frames: use JS builder (CDP doesn't traverse iframes) ---
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

  /**
   * Convert CDP AX tree nodes to our AXNode format.
   * CDP returns nodes with role.value and name.value — we normalize to role/name strings.
   * Filters out ignored/invisible nodes.
   */
  private _convertCDPAXTree(nodes: any[]): AXNode[] {
    const result: AXNode[] = [];

    for (const node of nodes) {
      const role = node.role?.value;
      const name = node.name?.value || "";

      if (!role) continue;

      // Skip layout/ignored roles
      if (role === "none" || role === "presentation" ||
          role === "LayoutTable" || role === "LayoutTableRow" ||
          role === "LayoutTableCell" || role === "LineBreak" ||
          role === "GenericContainer" || role === "Section") {
        continue;
      }

      // Skip empty names — unless it's a structural element used for extraction
      if (!name || name.trim().length === 0) {
        const structuralRoles = new Set(["main", "article", "region", "contentinfo", "document"]);
        if (!structuralRoles.has(role)) continue;
      }

      // Skip very long names (likely content, not interactive elements)
      if (name.length > 200) continue;

      // Check if node is ignored or hidden
      if (node.ignored) continue;

      result.push({
        role,
        name: name.substring(0, 200),
        value: node.value?.value,
        children: [],
      });
    }

    return result;
  }
}
