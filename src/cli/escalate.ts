/**
 * escalate command — exposes CDP endpoint for operator to connect.
 */

import { PlaywrightSurface } from "../surface/playwright-surface.js";

export async function runEscalate(_opts: Record<string, any>): Promise<void> {
  console.log("Escalation mode — exposing live browser session.");
  console.log("This is a manual operator workflow:");
  console.log("");
  console.log("1. The system pauses automation and launches a browser with CDP enabled");
  console.log("2. The CDP endpoint URL is printed below");
  console.log("3. Open Chrome and navigate to the CDP URL to take control");
  console.log("4. Perform manual steps in the browser");
  console.log("5. Signal done/complete/abort to resume or end the run");
  console.log("");

  const surface = new PlaywrightSurface({
    headless: false,
    remoteDebuggingPort: 9222,
    screenshotDir: "./evidence/screenshots",
  });

  await surface._start("http://localhost:3000");

  if (surface.exposeSession) {
    const session = await surface.exposeSession();
    console.log(`CDP Endpoint: ${session.endpoint}`);
    console.log(`Session Token: ${session.token}`);
    console.log("");
    console.log("To connect: open Chrome and go to chrome://inspect, or navigate to:");
    console.log(`  ${session.endpoint}`);
    console.log("");
    console.log("Press Ctrl+C when done to close the session.");
  } else {
    console.error("Surface does not support session exposure.");
  }

  // Keep the process alive until the operator presses Ctrl+C
  process.on("SIGINT", async () => {
    console.log("\nClosing session...");
    await surface.close();
    process.exit(0);
  });

  // Wait indefinitely
  await new Promise(() => {});
}
