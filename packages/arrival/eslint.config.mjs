import { readFileSync } from "node:fs";
import { nodejs } from "@here.build/eslint-configs";
// eslint-disable-next-line import-x/no-relative-packages -- repo-root overlay, not a package
import { arrivalOverlay } from "../../eslint.arrival.mjs";

// The arrow-fn trap: a symbol.native/symbol.rosetta impl must be `function (this: CallCtx, …)`, never an arrow.
const arrowFnTrap = {
  selector:
    "CallExpression[callee.type='TaggedTemplateExpression'][callee.tag.type='MemberExpression'][callee.tag.object.name='symbol'][callee.tag.property.name=/^(native|rosetta)$/] > ArrowFunctionExpression:nth-child(2)",
  message:
    "arrow-fn trap: a symbol.native/symbol.rosetta impl must be `function (this: CallCtx, …)`, not an arrow — dispatch delivers the live RunContext via `this`, and an arrow structurally cannot read it (silently minting CONSTANT_CTX-shaped values instead). See docs/execution.md §4 CALLCTX.",
};

// Re-export ban: `export … from` belongs ONLY in an index.ts barrel.
const reexportBan = {
  selector: "ExportAllDeclaration, ExportNamedDeclaration[source]",
  message:
    "Re-export (`export … from`) only in an index.ts barrel. Elsewhere import from the symbol's real home — a passthrough hides the real export.",
};

// P19: no module-level mutable state. Run-scoped state lives on RunContext; a module `let` is
// process-global and leaks between concurrent runs (docs/PRINCIPLES.md P19).
const noModuleLet = {
  selector:
    "Program > VariableDeclaration[kind='let'], Program > ExportNamedDeclaration > VariableDeclaration[kind='let']",
  message: "P19: no module-level mutable state — put run-scoped state on RunContext (docs/PRINCIPLES.md P19)",
};

const SRC_FILES = ["src/**/*.{ts,tsx}"];
const TEST_FILES = [
  "src/**/__tests__/**",
  "src/**/__benchmarks__/**",
  "src/**/__experiments__/**",
  "src/**/__visual__/**",
  "src/**/*.test.{ts,tsx}",
];

// Module-`let` allowlist — shared with the drift-alarm test (src/run/__tests__/concurrent-runs.law.test.ts)
// via module-let-allowlist.json. Each entry is NOT run state and carries its classification
// (docs/execution.md §1); remove an entry when its holder is gone.
const MODULE_LET_ALLOWLIST = JSON.parse(
  readFileSync(new URL("module-let-allowlist.json", import.meta.url), "utf8"),
).map((entry) => entry.path);

export default [
  ...nodejs,
  ...arrivalOverlay({
    tsconfigRootDir: import.meta.dirname,
    extraRules: {
      "@typescript-eslint/no-unsafe-function-type": "off",
      "unicorn/no-this-assignment": "off",
      "@typescript-eslint/no-this-alias": "off",
      "sonarjs/public-static-readonly": "off",
      "unicorn/filename-case": "off",
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "no-restricted-syntax": ["error", arrowFnTrap, reexportBan],
    },
    extraConfigs: [
      {
        files: SRC_FILES,
        ignores: [...TEST_FILES, ...MODULE_LET_ALLOWLIST],
        rules: { "no-restricted-syntax": ["error", arrowFnTrap, reexportBan, noModuleLet] },
      },
      {
        files: ["**/index.ts"],
        rules: { "no-restricted-syntax": ["error", arrowFnTrap] },
      },
      {
        files: ["src/**/index.ts"],
        ignores: [...TEST_FILES, ...MODULE_LET_ALLOWLIST],
        rules: { "no-restricted-syntax": ["error", arrowFnTrap, noModuleLet] },
      },
    ],
  }),
];
