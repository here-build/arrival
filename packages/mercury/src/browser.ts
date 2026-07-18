/**
 * Browser-safe projection entry — for the studio's `js` tab. Reuses the pure
 * `assemble` core and formats with **prettier standalone** (browser-bundleable),
 * NOT the Node `ESLint` class. The tradeoff vs the Node path: no eslint --fix, so
 * `{ x: x }` isn't collapsed to `{ x }` — but layout and wrapping (the legibility
 * that matters for a read-view) are fully applied.
 */
import * as estree from "prettier/plugins/estree";
import * as typescript from "prettier/plugins/typescript";
import * as prettier from "prettier/standalone";

import { assemble } from "./assemble.js";
import { type ProjectOptions } from "./imports.js";

// Browser-safe sibling (no eslint/prettier/fs): the prompt backends, for the
// studio's prompt-module target view.
export { getPromptBackend, PROMPT_BACKENDS, type PromptBackend } from "./prompt.js";

/** Project arrival-chain scheme → formatted TS, entirely in the browser. */
export async function projectToJsBrowser(source: string, opts: ProjectOptions = {}): Promise<string> {
  const raw = assemble(source, opts);
  // "typescript" parser, not "babel" — TS or nothing (dual-runtime design doc §0).
  return prettier.format(raw, {
    parser: "typescript",
    plugins: [typescript, estree],
    semi: true,
    singleQuote: false,
    printWidth: 100,
  });
}

export { type ProjectOptions } from "./imports.js";

export { assemble as projectToJsRaw } from "./assemble.js";
