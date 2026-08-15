import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@chief-of-staff/contracts": fileURLToPath(
        new URL("../packages/contracts/src/index.ts", import.meta.url)
      ),
      "@chief-of-staff/workflow": fileURLToPath(
        new URL("../packages/workflow/src/index.ts", import.meta.url)
      ),
      "@chief-of-staff/service": fileURLToPath(
        new URL("../apps/service/src/index.ts", import.meta.url)
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 60_000,
    hookTimeout: 60_000,
    pool: "threads",
  },
});
