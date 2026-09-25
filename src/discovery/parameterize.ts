/**
 * Replace the concrete values used during discovery with {{param}}
 * templates, everywhere they matter for replay: typed values and URLs,
 * target names/rows/labels, and checkpoint text.
 */

import type { ArtifactStep, ScreenSignature, StateGuard, TargetSpec } from "../artifact/types.js";

/** Values shorter than this are too likely to collide with unrelated text. */
const MIN_PARAM_VALUE_LENGTH = 3;

export function parameterizeSteps(steps: ArtifactStep[], paramValues: Record<string, string>): ArtifactStep[] {
  const entries = Object.entries(paramValues).filter(([, v]) => v && v.length >= MIN_PARAM_VALUE_LENGTH);
  if (entries.length === 0) return steps;

  const tpl = (text: string | undefined, caseInsensitive: boolean): string | undefined => {
    if (text === undefined) return undefined;
    return entries.reduce((acc, [name, value]) => {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return acc.replace(new RegExp(escaped, caseInsensitive ? "gi" : "g"), `{{${name}}}`);
    }, text);
  };

  const target = (t: TargetSpec | undefined): TargetSpec | undefined =>
    t && {
      ...t,
      ...(t.name !== undefined ? { name: tpl(t.name, true) } : {}),
      ...(t.row !== undefined ? { row: tpl(t.row, true) } : {}),
      ...(t.label !== undefined ? { label: tpl(t.label, true) } : {}),
    };

  const signature = (sig: ScreenSignature): ScreenSignature => ({
    ...sig,
    ...(sig.urlPattern !== undefined ? { urlPattern: tpl(sig.urlPattern, true) } : {}),
    ...(sig.textContains !== undefined ? { textContains: tpl(sig.textContains, true) } : {}),
    ...(sig.axContains ? { axContains: sig.axContains.map((a) => ({ ...a, name: tpl(a.name, true)! })) } : {}),
  });

  const guard = (g: StateGuard | undefined): StateGuard | undefined =>
    g && {
      ...(g.anyOf ? { anyOf: g.anyOf.map(signature) } : {}),
      ...(g.allOf ? { allOf: g.allOf.map(signature) } : {}),
    };

  return steps.map((step) => ({
    ...step,
    ...(step.value !== undefined ? { value: tpl(step.value, false) } : {}),
    ...(step.target ? { target: target(step.target) } : {}),
    ...(step.checkpoint ? { checkpoint: guard(step.checkpoint) } : {}),
  }));
}
