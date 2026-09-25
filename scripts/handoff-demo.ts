/**
 * Evidence run for the live-session handoff with a scripted operator.
 *
 * The profile's "System Notice" interstitial is removed, so the notice is an
 * UNKNOWN overlay: replay escalates, the operator (simulated here — in a real
 * run a person clicks in the browser, see `replay --handoff`) clears it on the
 * same live page, signals "done", and automation resumes.
 *
 * Usage: npx tsx scripts/handoff-demo.ts <artifact.json> '<params json>'
 */

import { PlaywrightSurface } from "../src/surface/playwright-surface.js";
import { EvidenceCollector } from "../src/evidence/evidence-collector.js";
import { ReplayEngine } from "../src/replay/replay-engine.js";
import { EscalationManager } from "../src/escalation/escalation-manager.js";
import type { OperatorChannel } from "../src/escalation/operator-channel.js";
import { loadArtifactFile } from "../src/artifact/artifact-store.js";
import { loadProfile } from "../src/artifact/profile-store.js";

async function main(): Promise<void> {
  const [artifactPath, paramsJson = "{}"] = process.argv.slice(2);
  if (!artifactPath) throw new Error("usage: handoff-demo.ts <artifact.json> '<params json>'");

  const artifact = loadArtifactFile(artifactPath);
  const profile = { ...loadProfile(artifact.surface.app), interstitials: [] };
  const evidence = new EvidenceCollector("./evidence");
  const surface = new PlaywrightSurface({ headless: true, screenshotDir: evidence.screenshotDir });
  await surface._start();

  const operator: OperatorChannel = {
    async requestIntervention(request) {
      console.log(`[operator] step ${request.stepId}: ${request.reason}`);
      await surface.act({ type: "click", target: { role: "button", name: "Acknowledge" } });
      return "done";
    },
  };

  try {
    const engine = new ReplayEngine({
      surface,
      evidenceCollector: evidence,
      profile,
      handoff: new EscalationManager(surface, evidence, operator),
    });
    const result = await engine.run(artifact, JSON.parse(paramsJson));
    console.log(`Status: ${result.status}`);
    console.log(JSON.stringify(result, null, 2));
    console.log(`Evidence: ${evidence.runDir}`);
  } finally {
    await surface.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
