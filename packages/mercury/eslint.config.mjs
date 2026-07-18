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
          defaultProject: "tsconfig.test.json",
          allowDefaultProject: [
            "src/__tests__/*.test.ts",
            // W2 conformance harness — nested one level deeper than the flat test
            // files above (corpus/support live alongside the *.test.ts rows).
            "src/__tests__/conformance/*.test.ts",
            "src/__tests__/conformance/support/*.ts",
          ],
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
    ignores: ["node_modules/*", "dist/*", "**/*.config.*", "src/**/fixtures/**", "**/*.js"],
  },
];
