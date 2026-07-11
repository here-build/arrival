import { nodejs } from "@here.build/eslint-configs";
import { fileURLToPath } from "node:url";
import path from "path";

// @ts-expect-error todo
// eslint-disable-next-line unicorn/no-negated-condition,unicorn/prefer-module
const dirname = typeof __dirname !== "undefined" ? __dirname : path.dirname(fileURLToPath(import.meta.url));

export default [
  ...nodejs,
  {
    files: ["src/**/*.ts"],
    ignores: ["**/__tests__/**", "**/*.test.ts", "**/*.spec.ts"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: dirname,
      },
    },
  },
  {
    // Test files - relaxed TypeScript project service
    files: ["**/__tests__/**/*.ts", "**/*.test.ts", "**/*.spec.ts"],
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["src/__tests__/*.ts", "src/__benchmarks__/*.ts"],
        },
        tsconfigRootDir: dirname,
      },
    },
  },
  {
    // Scheme-specific overrides - Lisp implementation needs flexibility
    rules: {
      // Lisp implementation needs 'any' for dynamic typing
      "@typescript-eslint/no-explicit-any": "off",
      // Many functions in Lisp are inherently flexible return types
      "sonarjs/function-return-type": "off",
      // Console allowed for REPL/debugging
      "no-console": "off",
      // Interpreter code is inherently complex
      "sonarjs/cognitive-complexity": "off",
      // PascalCase files are intentional for classes (SchemeString, Pair, etc.)
      "unicorn/filename-case": "off",
      // Lisp interpreter needs Function type for dynamic dispatch
      "@typescript-eslint/no-unsafe-function-type": "off",
      // `this` aliasing is common pattern in ported code
      "unicorn/no-this-assignment": "off",
      "@typescript-eslint/no-this-alias": "off",
      // Static properties in interpreter classes shouldn't be readonly
      "sonarjs/public-static-readonly": "off",
      // Regex patterns are core to parser, timing attacks not a concern
      "security/detect-possible-timing-attacks": "off",
      "security/detect-non-literal-regexp": "off",
      // Move functions is impractical for this codebase
      "unicorn/consistent-function-scoping": "off",
      // In dynamic Lisp code, || is often intentional for falsy handling
      "@typescript-eslint/prefer-nullish-coalescing": "off",
      // Type narrowing in interpreter is complex, these are often false positives
      "@typescript-eslint/no-unnecessary-condition": "off",
      // Stylistic regex preferences - code works fine
      "unicorn/prefer-regexp-test": "off",
      "sonarjs/prefer-regexp-exec": "off",
      // Regex complexity is inherent to parser
      "sonarjs/slow-regex": "off",
      "security/detect-unsafe-regex": "off",
      // Allow unused vars with underscore prefix (intentionally unused)
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // Import order is less critical in interpreter code
      "import-x/order": "off",
      // Loop counter updates in interpreter are intentional
      "sonarjs/updated-loop-counter": "off",
      // The arrow-fn trap (Wave 0 of the CONSTANT_CTX rework, docs/working-proposals/
      // arrival-constant-ctx-audit-2026-07-11.md §4/§0): dispatch delivers the LIVE
      // RunContext to every native/rosetta impl via `this: CallCtx`
      // (common/capability.ts's `hostImpl.apply(makeCallCtx(runCtx), args)`,
      // common/symbols/rosetta.ts's `rawImpl.call(this, ...)`) — but an impl authored
      // as an arrow function structurally CANNOT read `this`, and neither TypeScript
      // nor review flags the forfeiture. This selector targets exactly the impl
      // ARGUMENT (the 2nd call argument, right after the contract) of a
      // `symbol.native`/`symbol.rosetta` tagged-template call — never a bare helper
      // arrow elsewhere in the file (e.g. a local `const helper = (x) => …` used
      // INSIDE a properly-typed `function (this: CallCtx, …)` impl is untouched).
      // Scope note: arrival-core-only for now (this config); a shared/monorepo-wide
      // extension of this rule is a separate follow-up, not bundled here.
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.type='TaggedTemplateExpression'][callee.tag.type='MemberExpression'][callee.tag.object.name='symbol'][callee.tag.property.name=/^(native|rosetta)$/] > ArrowFunctionExpression:nth-child(2)",
          message:
            "arrow-fn trap: a symbol.native/symbol.rosetta impl must be `function (this: CallCtx, …)`, not an arrow — dispatch delivers the live RunContext via `this`, and an arrow structurally cannot read it (silently minting CONSTANT_CTX-shaped values instead). See docs/working-proposals/arrival-constant-ctx-audit-2026-07-11.md §4.",
        },
      ],
    },
  },
  {
    ignores: ["node_modules/*", "dist/*", "**/*.config.*", "debug-*.ts", "lib/**", "vendor/**", "src/__benchmarks__/**", "src/__tests__/**", "**/*.test.ts", "**/*.spec.ts"],
  },
];
