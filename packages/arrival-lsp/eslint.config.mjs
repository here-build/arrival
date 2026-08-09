import { nodejs } from "@here.build/eslint-configs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default [
  ...nodejs,
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parserOptions: {
        projectService: {
          // tsconfig.test.json includes src/__tests__ (its exclude overrides
          // the base's) — tests are project-matched, no capped
          // allowDefaultProject list needed.
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
    // .tsgo/ + src/tsgo/runtime/ hold VENDORED Go wasm_exec runtimes — foreign
    // code eslint must not parse (the sonarjs rule set crashes on it).
    // dist-cases/ are type-test fixtures (not real source).
    ignores: ["node_modules/*", "dist/*", "dist-cases/*", "**/*.config.*", "src/*.generated.ts", "scripts/*", ".tsgo/*", "src/tsgo/runtime/*"],
  },
];
