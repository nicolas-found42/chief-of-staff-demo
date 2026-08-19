import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@chief-of-staff-demo/shared": fileURLToPath(
        new URL("../packages/shared/src/index.ts", import.meta.url)
      ),
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "threads",
  },
});
