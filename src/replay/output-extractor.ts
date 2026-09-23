/**
 * OutputExtractor — extracts values from the page and maps to declared outputs.
 */

import type { ScreenState } from "../surface/types.js";
import type { LocatorSpec, OutputSpec } from "../artifact/types.js";
import { resolveLocator } from "../locator/locator-strategy.js";

export class OutputExtractor {
  /**
   * Extract a value from the current screen state using the locator spec.
   * Returns the text content of the resolved element.
   */
  static extract(locator: LocatorSpec, state: ScreenState): string | null {
    const result = resolveLocator(locator, state.axTree);
    if (!result.ok) return null;
    return result.node.value || result.node.name || null;
  }

  /**
   * Extract all declared outputs from the screen state.
   * Returns a map of output name -> extracted value.
   */
  static extractAll(
    _outputSpecs: OutputSpec[],
    steps: Array<{ output?: string; target: LocatorSpec }>,
    state: ScreenState
  ): Record<string, string> {
    const outputs: Record<string, string> = {};

    for (const step of steps) {
      if (step.output) {
        const value = OutputExtractor.extract(step.target, state);
        if (value !== null) {
          outputs[step.output] = value;
        }
      }
    }

    return outputs;
  }
}
