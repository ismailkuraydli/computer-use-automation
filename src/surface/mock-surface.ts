/**
 * MockSurface — in-memory Surface implementation for unit tests.
 * Returns scripted ScreenStates. No browser, no network.
 */

import type { Surface, ScreenState, Action, ActionResult, AXNode } from "./types.js";

export class MockSurface implements Surface {
  private url: string;
  private axTree: AXNode[];
  private stepCount = 0;
  private stateSequence: ScreenState[];

  constructor(initialUrl: string = "http://localhost:3000", axTree: AXNode[] = []) {
    this.url = initialUrl;
    this.axTree = axTree;
    this.stateSequence = [];
  }

  /** Set the states that observe() will return in sequence. */
  setStateSequence(states: ScreenState[]): void {
    this.stateSequence = states;
  }

  async observe(): Promise<ScreenState> {
    if (this.stateSequence.length > 0 && this.stepCount < this.stateSequence.length) {
      return this.stateSequence[this.stepCount];
    }
    return {
      url: this.url,
      title: "Mock Page",
      axTree: this.axTree,
      domSnapshot: "<html></html>",
      frameUrls: [this.url],
    };
  }

  async act(action: Action): Promise<ActionResult> {
    this.stepCount++;

    // Simulate navigation
    if (action.type === "navigate" && action.value) {
      this.url = action.value;
    }

    // Get current state from sequence for extract
    const currentState = this.stateSequence.length > 0 && this.stepCount <= this.stateSequence.length
      ? this.stateSequence[this.stepCount - 1]
      : null;

    // Simulate extract using the current state sequence's axTree
    if (action.type === "extract" && action.target) {
      const tree = currentState?.axTree || this.axTree;
      const node = tree.find(
        (n) => n.role === action.target!.role && n.name === action.target!.name
      );
      if (node) {
        return { ok: true, extractedValue: node.value || node.name };
      }
    }

    // Simulate scroll
    if (action.type === "scroll") {
      return { ok: true };
    }

    // Simulate read_page_text
    if (action.type === "read_page_text") {
      return { ok: true, extractedValue: "Mock page text content" };
    }

    // For click/type/submit — check if the target exists in the current state
    if (action.target && (action.type === "click" || action.type === "type" || action.type === "submit")) {
      const tree = currentState?.axTree || this.axTree;
      const found = tree.some(
        (n) => n.role === action.target!.role && n.name === action.target!.name
      );
      if (!found && tree.length > 0) {
        return { ok: false, error: "element-not-found", detail: `Mock: ${action.target!.role} "${action.target!.name}" not in current state` };
      }
    }

    return { ok: true };
  }

  async navigate(url: string): Promise<ActionResult> {
    this.url = url;
    return { ok: true };
  }

  async close(): Promise<void> {
    // No-op
  }
}
