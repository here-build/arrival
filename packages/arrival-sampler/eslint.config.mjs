import { shared } from "@here.build/eslint-configs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dirname = path.dirname(fileURLToPath(import.meta.url));

// `shared` (shared-node-browser globals): the runtime modules are browser-safe, the tests run in
// node. browserslist env=node keeps the lint downlevel checks lenient enough for both.
export default [
  ...shared,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: {
          // tsconfig.test.json includes all of src/** (the base check carries no src exclude), so every
          // linted file is project-matched — no capped allowDefaultProject list needed (cf. arrival-lsp).
          defaultProject: "tsconfig.test.json",
        },
        tsconfigRootDir: dirname,
      },
    },
  },
  {
    files: ["src/**/*.test.ts"],
    rules: {
      "no-console": "off",
      "sonarjs/no-nested-functions": "off",
    },
  },
  {
    // Non-product code (tests / research / benchmarks / custdev) relaxes a few ERGONOMICS rules that fight
    // idiomatic local test+research helpers — never correctness rules.
    files: [
      "src/__tests__/**/*.ts",
      "src/__research__/**/*.ts",
      "src/__benchmarks__/**/*.ts",
      "src/__custdev__/**/*.ts",
      "src/__experiments__/**/*.ts",
    ],
    rules: {
      "unicorn/consistent-function-scoping": "off",
      "sonarjs/assertions-in-tests": "off",
      "no-secrets/no-secrets": "off",
      "sonarjs/no-identical-functions": "off",
      "sonarjs/no-nested-assignment": "off",
    },
  },
  {
    ignores: ["node_modules/*", "dist/**", "dist-server/**", "**/*.config.*", "scripts/**"],
  },
];
