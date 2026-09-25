import { createMockApp, type MockVariant } from "./app.js";

// MOCK_VARIANT=summit PORT=3100 runs the second tenant (npm run mock-app:summit)
const variant = (process.env.MOCK_VARIANT ?? "keystone") as MockVariant;
const PORT = Number(process.env.PORT) || 3000;

if (variant !== "keystone" && variant !== "summit") {
  console.error(`Unknown MOCK_VARIANT "${variant}" (expected keystone or summit)`);
  process.exit(2);
}

createMockApp({ variant }).app.listen(PORT, () => {
  console.log(`${variant === "summit" ? "Summit FCU" : "Keystone CU"} mock app running on http://localhost:${PORT}`);
  console.log(`Inject runtime faults: curl -X POST localhost:${PORT}/__faults -H 'content-type: application/json' -d '{"slowMs":2000}'`);
});
