/**
 * COPY-AS-CHUNK (constitution §4.5 — greenfield package, never shared imports).
 * Source: inhuman/public-packages/mercury/src/names.ts (the naming-ladder half).
 *
 * Identifier naming. `cleanName` is the base of the ladder defined in
 * `here.build/docs/package-specific/mercury-compiler/lexical-js-naming.md` — kebab→camel, drop
 * predicate `?` / mutate `!`, lower `->`, escape reserved words. It is a PURE
 * function of the scheme name, position-independent; the scope-aware resolver
 * (`./scheme-scope.ts`) layers collision resolution on top via `nameCandidates`.
 *
 * Adaptations from the source chunk:
 *   - REDUCED to the two naming functions the front-end owns (`cleanName`,
 *     `nameCandidates`). The dropped members — `elementName`, `destructureTuple`,
 *     `containsAwaitToken` — are string-plane run-emitter machinery that the
 *     Residual algebra + ASYNC-IFY replace (constitution §3.4, Law W), so they
 *     must not seed the greenfield tree. Dropping `elementName` also drops the
 *     `pluralize` dependency.
 */

const RESERVED = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "enum",
  "await",
  "async",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "arguments",
  "eval",
]);

/**
 * Scheme identifier → JS identifier. Pure, total, deterministic.
 *   run-predict  → runPredict
 *   dominates?   → dominates
 *   string->list → stringToList
 *   set-x!       → setX
 */
export function cleanName(scheme: string): string {
  let s = scheme;
  s = s.replaceAll("->", "-to-"); // string->list → string-to-list
  s = s.replaceAll(/[?!]/g, ""); // predicate? / mutate! markers carry no JS meaning
  s = s.replaceAll("*", ""); // earmuffed *globals*
  s = s.replaceAll(/[^\w-]/g, "-"); // any other punctuation → separator
  s = s.replaceAll(/[-_]+([a-z0-9])/gi, (_m, c: string) => c.toUpperCase()); // kebab/snake → camel
  s = s.replaceAll(/[-_]+$/g, ""); // trailing separators
  if (s === "") s = "_";
  if (/^\d/.test(s)) s = `_${s}`;
  if (RESERVED.has(s)) s = `${s}_`;
  return s;
}

/**
 * The friendly-name LADDER for a scheme identifier — preference-ordered JS-name
 * candidates a collision resolver tries in turn before falling to a `_2` postfix
 * (the `is<Symbol>` rung of the ladder in `here.build/docs/package-specific/mercury-compiler/lexical-js-naming.md`).
 *
 * Tier 1 is always `cleanName`. A predicate `foo?` gets a 2nd tier `isFoo` — the JS
 * boolean convention — so when `foo` is already taken (a loop var shadows the
 * predicate, as `picked` shadows `picked?` in gepa-full) the resolver picks the
 * readable `isFoo`, not `foo_2`. Pure function of the name; the scope-aware resolver
 * that consumes it lives in `./scheme-scope.ts`.
 */
export function nameCandidates(scheme: string): string[] {
  const base = cleanName(scheme);
  // A predicate whose base doesn't already READ as a boolean → offer `isBase` next.
  // Skip when it already starts with a boolean verb (`hasChildren`, not `isHasChildren`).
  const reads = /^(is|has|can|should|will|was|had|are)[A-Z]/.test(base);
  if (scheme.endsWith("?") && base !== "" && base !== "_" && !reads) {
    return [base, `is${base.charAt(0).toUpperCase()}${base.slice(1)}`];
  }
  return [base];
}
