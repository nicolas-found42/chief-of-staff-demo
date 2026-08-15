import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "local-workspace/**", "raw/**", "tests/playwright-report/**", "apps/web/dist/**"] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: {
        console: "readonly",
        process: "readonly",
        URL: "readonly",
        __dirname: "readonly",
      },
    },
  },
  {
    files: ["**/*.test.ts", "**/tests/**", "e2e/**"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  }
);
