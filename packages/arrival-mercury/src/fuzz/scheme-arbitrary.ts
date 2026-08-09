/**
 * The schema-driven fuzzer's value generator (oracle-harness.md §4.4; constitution
 * §5.4/Law N). The doc's own `arbitraryForZodDef` walks a Contract's `input` zod def —
 * but every symbol harvested with a `narrows` flag TODAY (`null?`, `pair?` off the
 * phase1 overlay, `registry/harvest.ts` + `rules/phase1.ts`) is a compiler-side
 * `SymbolRule`, not a zod-schema-carrying Contract (registry-emit.md's own gap, cited
 * verbatim in oracle-harness.md §3: `EmitRegistryRow` has no `input`/`inputRest` field
 * to walk). So this module is the OTHER branch oracle-harness.md's `schemaFor` already
 * names: a hand-rolled SCHEME-VALUE generator standing in for "any representable
 * argument," scoped for THIS MVP to exactly the value kinds the mission specifies —
 * integers (safe range), strings, booleans, nested proper lists (depth ≤3), and the
 * empty list. (The fuller harness spec's own generator additionally samples
 * `fc.double`/dotted-pair 2-tuples; both are cut here — see the module-level note
 * below on why, and `narrows-fuzz.test.ts`'s header for what that scope cut actually
 * found.)
 *
 * RENDERING, not passing JS values directly: the fuzzer builds a `.scm` SOURCE
 * string (`narrows-fuzz.ts`'s program synthesis), so a sampled value must round-trip
 * through arrival's own reader identically on both the interpreter side
 * (`@inhuman.tools/arrival`'s production parser) and the compiled side (this package's
 * `front/parse.ts`, a copy-as-chunk of arrival-sugarcoat's classic-scheme parser).
 *
 * Why strings are scoped to a fixed safe charset (space through `~`, minus `"` and
 * `\`): `front/parse.ts`'s `readString` does NOT decode backslash-escapes — it stores
 * `\` + the following character VERBATIM as two literal characters in the atom
 * (verified by direct read, `front/parse.ts:70-74`: `out += src[i] + (src[i+1] ?? "")`).
 * Whether the interpreter's own production reader decodes escapes the same way is a
 * SEPARATE, unverified question this MVP does not need to answer — restricting the
 * charset to characters that need zero escaping in ANY reader (no quote, no
 * backslash, no control characters) sidesteps the ambiguity entirely and keeps the
 * fuzz signal on `null?`/`pair?` semantics, not on parser round-trip fidelity (a
 * legitimate but separate concern for a dedicated reader-fuzz effort).
 */
import * as fc from "fast-check";

/** A generated Scheme value, JS-side, before rendering to source text. Proper lists
 *  only (no dotted-pair 2-tuples) — the mission's stated generator scope. */
export type SchemeSample = number | string | boolean | readonly SchemeSample[];

/** Printable ASCII, space (0x20) through tilde (0x7e), minus the two characters that
 *  would need escaping inside a `"…"` string literal. 92 characters — letters,
 *  digits, and most punctuation survive; plenty of texture for a `null?`/`pair?`
 *  fuzz target without touching the escape question at all. */
const SAFE_STRING_CHARS: readonly string[] = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) =>
  String.fromCharCode(0x20 + i),
).filter((c) => c !== '"' && c !== "\\");

const safeChar: fc.Arbitrary<string> = fc.constantFrom(...SAFE_STRING_CHARS);

/** 0-8 characters from the safe charset — includes the empty string naturally
 *  (fast-check tries small/edge lengths early), which is exactly the boundary this
 *  fuzzer's own first real finding lives at (see `narrows-fuzz.test.ts`'s header). */
const schemeString: fc.Arbitrary<string> = fc.array(safeChar, { maxLength: 8 }).map((cs) => cs.join(""));

/** Integers within safe range (mission scope: no doubles/bigints for this MVP — see
 *  the module header). `fc.integer()`'s default bounds are well within
 *  `Number.isSafeInteger` and the RATIO ruling's exact-integer ceiling (§7), so every
 *  sample ingresses as a scheme EXACT with zero overflow risk. */
const schemeScalar: fc.Arbitrary<SchemeSample> = fc.oneof(fc.integer(), schemeString, fc.boolean());

/**
 * Any representable Scheme value the mission's scope covers: scalars (weighted
 * heaviest — most samples should exercise the false/`'skip` branch cheaply), an
 * explicit empty-list case (the mission calls it out separately from "nested
 * lists" — mirrors the harness spec's own dedicated `fc.constant(null /* '() *\/)`
 * line), and nested proper lists up to `maxDepth` (default 3, matching
 * `typefacts-extraction.md §6 E8`'s own depth-cap rationale, cited by the harness
 * spec's twin generator).
 */
export function arbitrarySchemeValue(maxDepth = 3): fc.Arbitrary<SchemeSample> {
  const build = (depth: number): fc.Arbitrary<SchemeSample> =>
    depth >= maxDepth
      ? schemeScalar
      : fc.oneof(
          { weight: 4, arbitrary: schemeScalar },
          { weight: 1, arbitrary: fc.constant<SchemeSample>([]) },
          { weight: 2, arbitrary: fc.array(build(depth + 1), { maxLength: 4 }) },
        );
  return build(0);
}

/**
 * Render a sampled value as `.scm` source text. Lists render as `(list …)` calls
 * (composes naturally for nesting, matches the existing corpus's own idiom —
 * `equal-nested-list.scm`'s `(list 1 (list 2 3))`) rather than a quoted datum, so no
 * quoting/quasiquote reader path is exercised here at all — one fewer moving part
 * between "the value I sampled" and "the value the program observes." The empty
 * list renders as `'()` (matches `car-empty.scm`'s existing idiom) — `(list)` would
 * be equally correct (R7RS: 0-ary `list` returns `'()`) but `'()` reads clearer.
 */
export function renderSchemeLiteral(v: SchemeSample): string {
  if (typeof v === "number") return String(v);
  if (typeof v === "boolean") return v ? "#t" : "#f";
  if (typeof v === "string") return `"${v}"`;
  return v.length === 0 ? "'()" : `(list ${v.map(renderSchemeLiteral).join(" ")})`;
}
