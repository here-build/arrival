import { is_function } from "../values/value-guards.js";
import { CLASS } from "../well-known-symbols.js";

/**
 * `type()` — the human-facing type NAME of any value, for error messages and the one
 * macro-literal dispatch site (eval/syntax-rules `same_atom`).
 *
 * THE BRAND IS THE TYPE (P7 key taxonomy): every arrival class carries
 * `static [CLASS] = "<name>"` (`CLASS` = the string key `"arrival/class"`), and this
 * module is a thin reader over that brand — no central instanceof switch.
 *
 * Keep it a LEAF: no imports from values/primitives or eval. Reading brands
 * structurally (not `instanceof` on imported classes) is what avoids an ESM init cycle
 * through Macro/Syntax.
 *
 * Deliberate treatments (each defends a non-obvious branch):
 * - `null` guard stays FIRST: `null.constructor` throws.
 * - raw JS `NaN` reports `"NaN"`; a BOXED AInexact holding NaN reports `"number"` like
 *   any inexact. Asymmetry kept: the raw NaN name flags an unboxed JS value leaking
 *   into a message — renaming boxed NaN would hide that signal.
 * - raw `Array`/`RegExp` are FOREIGN natives (cannot carry a brand): the only two
 *   instanceof arms left, at the boundary where they belong. Raw arrays report
 *   `"array"` — deliberately distinct from AJSArray's `"js-array"` brand (borrowed vs
 *   raw is a real difference at a membrane).
 * - anything object-shaped with neither brand nor native arm reports `foreign:<CtorName>`
 *   — an honest, greppable marker, not a lowercased constructor name that would silently
 *   mint unbounded vocabulary (e.g. "r7rserror").
 * - plain objects (ctor === Object) and anonymous classes report `"object"`.
 * - callers may still override for pedagogy (evaluator's not-callable door reports
 *   dict-SHAPED AJSObjects as "dict" — a door-specific teaching choice, not a brand).
 *
 * Adjacent vocabularies that are deliberately NOT this one: scheme-zod's `named()`
 * codec names (a third namespace by design, see its header) and polyglot's in-scheme
 * `%dict-guard` phrases. Do not unify.
 */
export function type(obj: unknown): string {
  if (obj === null) return "null";
  if (typeof obj === "number") return Number.isNaN(obj) ? "NaN" : "number";
  if (typeof obj === "bigint") return "number";
  if (obj === undefined) return "void";
  if (typeof obj !== "object") return typeof obj; // string/boolean/function/symbol — raw JS

  // The brand read — same idiom as value-guards' is_macro_value.
  const ctor = (obj as { constructor?: { [CLASS]?: unknown; name?: string } }).constructor;
  const brand = ctor?.[CLASS];
  if (typeof brand === "string") return brand;

  // Foreign natives — cannot carry a brand; named at the boundary.
  if (Array.isArray(obj)) return "array";
  if (obj instanceof RegExp) return "regex";

  const name = ctor?.name;
  if (!name || name === "Object") return "object";
  return `foreign:${name}`;
}

export function typeErrorMessage(fn: unknown, got: string, expected: unknown, position: number | null = null) {
  let postfix = fn ? ` in expression \`${fn}\`` : "";
  if (position !== null) {
    postfix += ` (argument ${position})`;
  }
  if (is_function(expected)) {
    return `Invalid type: got ${got}${postfix}`;
  }
  if (Array.isArray(expected)) {
    if (expected.length === 1) {
      const first = expected[0].toLowerCase();
      expected = `a${"aeiou".includes(first) ? "n " : " "}${expected[0]}`;
    } else {
      expected = new Intl.ListFormat("en", {
        style: "long",
        type: "disjunction",
      }).format(expected);
    }
  }
  return `Expecting ${expected} got ${got}${postfix}`;
}
