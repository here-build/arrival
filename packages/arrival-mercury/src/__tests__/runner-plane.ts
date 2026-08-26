/**
 * Test-only host plane assembled from packages in this workspace.
 *
 * Mercury does not default a product vocabulary. Production hosts pass their
 * own `capabilities`. These tests need *a* assembled session; they do not need
 * Inhuman's inference pack (`@inhuman.tools/runner-capability` / `llm-plane`).
 */
import { EnvCapability, jsToScheme, toJS, type SchemeValue } from "@inhuman.tools/arrival";
import { overridableCapability } from "@inhuman.tools/arrival/capabilities/overridable";
import { schemaCapability } from "@inhuman.tools/arrival/capabilities/schema";
import { arrivalLoaderCapability } from "@inhuman.tools/arrival-modules";
import { arrivalHandlebarsCapability } from "@inhuman.tools/arrival-modules/handlebars";
import { arrivalYamlCapability } from "@inhuman.tools/arrival-modules/yaml";

import { openProbeSession, type ProbeSession } from "../probe/session.js";
import { openOracleSession, type OracleSession } from "../registry/greenfield-session.js";

/**
 * In-repo stand-in for the product runner pack: file-type loaders already in
 * `arrival-modules`, overridable/schema from core, plus the six scheme helpers
 * notebooks spell (`count-if`/`max-by`/`field`/…). No LLM/MCP/prompt verbs.
 */
const testPlaneCapability = EnvCapability.define("arrival/test-plane", {
  // C3 local-precedence is left-to-right higher-first. Loader last among deps
  // so file packs that `deps: [loader]` linearize without AssembleLinearizationError.
  deps: [
    arrivalHandlebarsCapability,
    arrivalYamlCapability,
    overridableCapability,
    schemaCapability,
    arrivalLoaderCapability,
  ],
  symbols: (symbol, z) => ({
    // Compiler-fixture name: `inferAsyncSeeds` / stage0 still key async-ify
    // off the symbol `infer`. Not the product verb — a bound name so goldens
    // that seed asynchrony compile instead of dooring as unbound.
    "infer": symbol.rosetta`infer: test-plane async-seed stand-in`(
      {
        input: [z.string, z.dynamic],
        output: [z.dynamic],
        provenance: "source",
        type: "(model: string, prompt: unknown): unknown",
      },
      async function (_model: unknown, x: unknown) {
        return jsToScheme(this.runCtx, toJS(x as SchemeValue));
      },
    ),
    "count-if": symbol.define`count-if: (count-if pred xs) → how many elements of xs satisfy pred`(
      {
        input: [z.lambda, z.listAlike],
        output: [z.schemeNumber],
        type: "(pred: (x: unknown) => unknown, xs: unknown[]): number",
      },
      `(lambda (pred xs)
         (if (null? xs)
             0
             (if (pred (car xs))
                 (+ 1 (count-if pred (cdr xs)))
                 (count-if pred (cdr xs)))))`,
    ),
    "max-by": symbol.define`max-by: (max-by f xs) → the element of xs maximizing (f x); ties go to the first`(
      {
        input: [z.lambda, z.listAlike],
        output: [z.schemeValue],
        type: "(f: (x: unknown) => number, xs: unknown[]): unknown",
      },
      `(lambda (f xs)
         (let loop ((best (car xs)) (rest (cdr xs)))
           (if (null? rest)
               best
               (if (> (f (car rest)) (f best)) (loop (car rest) (cdr rest)) (loop best (cdr rest))))))`,
    ),
    "field": symbol.rosetta`field: reads a field off a JS-object-shaped container (alist or JS object); "" when absent`(
      {
        input: [z.dynamic, z.dynamic],
        output: [z.dynamic],
        provenance: "pipe",
        type: "(container: unknown, key: unknown): unknown",
      },
      function (containerRaw: unknown, keyRaw: unknown) {
        const container = toJS(containerRaw as SchemeValue);
        const key = toJS(keyRaw as SchemeValue);
        let value: unknown = "";
        if (Array.isArray(container)) {
          const hit = container.find((entry) => Array.isArray(entry) && entry.length === 2 && entry[0] === key);
          if (hit !== undefined) value = (hit as readonly [unknown, unknown])[1];
        } else if (container !== null && typeof container === "object") {
          const v = (container as Record<string, unknown>)[String(key)];
          if (v !== undefined) value = v;
        }
        return jsToScheme(this.runCtx, value);
      },
    ),
    "keys-of": symbol.rosetta`keys-of: the field names of a JS-object-shaped value, as a list`(
      { input: [z.dynamic], output: [z.dynamic], provenance: "pipe", type: "(obj: unknown): string[]" },
      function (objRaw: unknown) {
        const obj = toJS(objRaw as SchemeValue);
        return jsToScheme(this.runCtx, obj !== null && typeof obj === "object" ? Object.keys(obj) : []);
      },
    ),
    "values-of": symbol.rosetta`values-of: the field values of a JS-object-shaped value, as a list`(
      {
        input: [z.dynamic],
        output: [z.dynamic],
        provenance: "pipe",
        type: "<T extends Record<string, unknown>>(obj: T): List<T[keyof T]>",
      },
      function (objRaw: unknown) {
        const obj = toJS(objRaw as SchemeValue);
        return jsToScheme(this.runCtx, obj !== null && typeof obj === "object" ? Object.values(obj) : []);
      },
    ),
    "entries-of": symbol.rosetta`entries-of: (list (list key value) ...) over a JS-object-shaped value`(
      { input: [z.dynamic], output: [z.dynamic], provenance: "pipe", type: "(obj: unknown): [string, unknown][]" },
      function (objRaw: unknown) {
        const obj = toJS(objRaw as SchemeValue);
        return jsToScheme(this.runCtx, obj !== null && typeof obj === "object" ? Object.entries(obj) : []);
      },
    ),
  }),
});

export const TEST_PLANE = [testPlaneCapability] as const;
/** Existing test imports. Same plane. */
export const RUNNER_PLANE = TEST_PLANE;

export function openRunnerOracleSession(): Promise<OracleSession> {
  return openOracleSession(TEST_PLANE);
}

export function openRunnerProbeSession(): Promise<ProbeSession> {
  return openProbeSession(TEST_PLANE);
}
