/**
 * The "optimize + format" tail of the pipeline. The lowering pass emits naive,
 * verbose-but-correct JS; this pass idiomatizes it (eslint --fix) and lays it out
 * (prettier). Faithfulness lives in the naive pass; idiom + layout live here.
 *
 * Both run IN-PROCESS (no shelling out, no temp files) so the projection stays a
 * pure async function of its input — same source → same formatted output.
 */
import * as tsParser from "@typescript-eslint/parser";
import { ESLint } from "eslint";
import * as prettier from "prettier";

// A tiny fixable-only ruleset. These are the reductions the naive emitter leans
// on: `{ x: x }` → `{ x }`, redundant `{ return e }` arrow bodies → `e`. All
// syntax-level rules — but the run-view now emits TYPE ANNOTATIONS
// (types/explicit-signatures), so the parse must be the TS parser, not espree
// (TS or nothing, dual-runtime design doc §0). Still no tsconfig / project
// service — a bare single-file parse.
const eslint = new ESLint({
  fix: true,
  overrideConfigFile: true,
  overrideConfig: {
    // Flat config lints only `.js`-family files unless the pattern says otherwise —
    // without this line the `.mts` lint is silently skipped and no fix applies.
    files: ["**/*.mts"],
    languageOptions: { parser: tsParser, ecmaVersion: 2023, sourceType: "module" },
    rules: {
      "object-shorthand": ["error", "always"],
      "arrow-body-style": ["error", "as-needed"],
      "prefer-const": "error",
      "no-useless-rename": "error",
    },
  },
});

/** eslint --fix then prettier. Pure: depends only on `code`. */
export async function formatJs(code: string): Promise<string> {
  // `.mts` so eslint treats it as an ES module without a config file (TS parser).
  let fixed = code;
  try {
    const [result] = await eslint.lintText(code, { filePath: "projection.mts" });
    fixed = result?.output ?? code;
    // "typescript" parser, not "babel" — TS or nothing (dual-runtime design doc §0):
    // every emitted module is TypeScript, including this read-view "glass".
    return await prettier.format(fixed, { parser: "typescript", semi: true, singleQuote: false, printWidth: 100 });
  } catch (error) {
    // A format failure means the lowering emitted invalid JS — surface the offending
    // source, not an opaque parser stack trace.
    throw new Error(
      `mercury: generated JS failed to format (likely an emit bug).\n` +
        `--- generated ---\n${fixed}\n--- cause ---\n${(error as Error).message}`,
    );
  }
}
