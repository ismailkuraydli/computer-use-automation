import { createMockApp } from "./app.js";

const PORT = 3000;

createMockApp().app.listen(PORT, () => {
  console.log(`Keystone CU mock app running on http://localhost:${PORT}`);
  console.log(`Inject runtime faults: curl -X POST localhost:${PORT}/__faults -H 'content-type: application/json' -d '{"slowMs":2000}'`);
});
