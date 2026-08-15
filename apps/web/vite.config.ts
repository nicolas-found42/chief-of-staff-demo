import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@chief-of-staff/contracts": fileURLToPath(
        new URL("../../packages/contracts/src/index.ts", import.meta.url)
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/v1": {
        target: "http://127.0.0.1:4317",
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});
