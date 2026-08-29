import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

/**
 * One config for four workspaces and three runtimes. Typed linting throughout
 * (`projectService`), because the rules worth having here — a dropped promise in
 * the Run engine, a condition that can never be false — need types to see.
 *
 * The boundary rules near the bottom are the point of having a linter at all:
 * they turn ADR prose into errors — ADR-0011 and ADR-0018 on who may hold
 * Google credentials, and the web app's API-only reach into the server. Each
 * rule cites its own ADR in the message it reports.
 */
export default tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/node_modules/**",
      "workspace/**",
      ".claude/worktrees/**",
      ".scratch/**",
      ".archive/**",
      "coverage/**",
      "**/test-results/**",
      "**/playwright-report/**",
      "p/**",
    ],
  },

  js.configs.recommended,
  tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      parserOptions: {
        projectService: {
          // Files no tsconfig lists: this config, the root manifests' siblings,
          // and the hermetic e2e server.
          allowDefaultProject: ["eslint.config.js", "tests/e2e/start-server.mjs"],
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The complement to noUncheckedIndexedAccess: that flag catches the
      // unguarded access, this one catches the guard that can never fire.
      "@typescript-eslint/no-unnecessary-condition": "error",

      // Off deliberately. Two patterns here are async without awaiting, both
      // correct: a Fastify route handler, which the framework wants async, and
      // an implementation of a Promise-returning interface method that happens
      // to have a synchronous answer (Runner.startRun, every test double). All
      // 83 hits were one of those two.
      "@typescript-eslint/require-await": "off",
    },
  },

  // --- apps/web: React, browser, no server ---------------------------------
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks, "react-refresh": reactRefresh },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
      // There is no HMR in this repo. Keep component exports separate from
      // non-component exports so each module has one clear responsibility.
      "react-refresh/only-export-components": "error",
    },
  },

  // --- boundary rules: ADRs made mechanical --------------------------------
  {
    // ADR-0011/0018: the Google connection is the only holder of client
    // credentials and refresh tokens. Every Intake and Output Adapter reaches
    // Google with an auth client obtained from `google/oauth.ts` — importing
    // googleapis is fine and expected, minting your own authorization is not.
    files: ["apps/server/src/**/*.ts"],
    ignores: ["apps/server/src/google/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "google-auth-library",
              message:
                "Only apps/server/src/google/ may build Google authorization. Take an auth client from buildGoogleAuth() instead (ADR-0018).",
            },
          ],
        },
      ],
      "no-restricted-syntax": [
        "error",
        {
          selector: 'MemberExpression[object.name="google"][property.name="auth"]',
          message:
            "Only apps/server/src/google/ may build Google authorization. Take an auth client from buildGoogleAuth() instead (ADR-0018).",
        },
      ],
    },
  },
  {
    // The web app talks to the server over the API and nowhere else, and it runs
    // in a browser: no Node builtins, no reaching across the workspace.
    files: ["apps/web/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/apps/server/**", "@chief-of-staff-demo/server"],
              message:
                "The web app reaches the server through the HTTP API only. Put shared types in packages/shared.",
            },
            {
              group: ["node:*"],
              message: "apps/web runs in a browser; there are no Node builtins there.",
            },
          ],
        },
      ],
    },
  },

  // --- tests ---------------------------------------------------------------
  {
    files: ["tests/**/*.ts"],
    rules: {
      // Test doubles for googleapis' loose types cannot be built without these.
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
    },
  },

  // --- plain JS/MJS: no type information to lint with ----------------------
  {
    files: ["**/*.{js,mjs}"],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },

  prettier,
);
