/**
 * Write the hand-written scenario-matrix artifacts as JSON files, so the
 * CLI can replay them. Usage: npx tsx scripts/export-fixture-artifacts.ts <dir> [baseUrl]
 */

import { mkdirSync, writeFileSync } from "fs";
import path from "path";
import { lookupSavingsBalance, manageAccountByType, openSubAccount } from "../src/scenarios/mock-app-artifacts.js";

const [outDir, baseUrl = "http://localhost:3000"] = process.argv.slice(2);
if (!outDir) {
  console.error("usage: export-fixture-artifacts.ts <dir> [baseUrl]");
  process.exit(1);
}

for (const build of [lookupSavingsBalance, manageAccountByType, openSubAccount]) {
  const artifact = build(baseUrl);
  const file = path.join(outDir, artifact.capability, "v1.json");
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(artifact, null, 2) + "\n");
  console.log(file);
}
