import { nodejs } from "@here.build/eslint-configs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default [
  ...nodejs,
  {
    files: ["src/**/*.{ts,tsx}"],
    languageOptions: {
      parserOptions: {
        projectService: {
          defaultProject: "tsconfig.test.json",
          allowDefaultProject: ["src/__tests__/*.test.ts"],
        },
        tsconfigRootDir: dirname,
      },
    },
  },
  {
    // The radix-number matchers are lifted FAITHFULLY from
    // @codemirror/legacy-modes/mode/scheme — complexity is theirs to keep. And
    // `stream.match(re)` is the CONSUMING StreamParser API — the prefer-regexp-test
    // autofix rewrites it into a non-consuming (and ill-typed) `re.test(stream)`.
    files: ["src/scheme-sugarcoat.ts"],
    rules: {
      "sonarjs/regex-complexity": "off",
      "sonarjs/slow-regex": "off",
      "regexp/no-useless-non-capturing-group": "off",
      "regexp/no-super-linear-backtracking": "off",
      "unicorn/prefer-regexp-test": "off",
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
    ignores: ["node_modules/*", "dist/*", "**/*.config.*"],
  },
];
