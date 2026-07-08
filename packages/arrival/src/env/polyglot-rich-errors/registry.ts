// @here.build/arrival/env/polyglot-rich-errors/registry — the WELL-KNOWN-SYMBOL
// data table + `richErrorFor`, the typo-enrichment half of the `polyglot-rich-errors`
// sub-capability (see `./index.ts` for the pairing with `./stubs.ts`).
//
// ZERO IMPORTS BY DESIGN. This module is pure data + pure functions — no
// `EnvCapability`, no `symbol.*`, nothing from `common/` or `values/`. That is
// load-bearing: the unbound-variable throw sites this feeds (`Environment.ts`,
// `eval/Resolver.ts`, `eval/evaluator.ts`) sit BELOW `env/*` in the module graph
// (`env/polyglot.ts` → `common/symbol.js` → `eval/Macro.js` / `Environment.js`),
// so importing the SIBLING `./stubs.ts` (which pulls `common/capability.js` →
// `common/symbol.js` → `eval/Macro.js`) from an eval-layer file would risk a
// cycle. A dependency-free registry can be imported from anywhere, in any
// direction, with no risk.
//
// GATING (the load-bearing constraint): `richErrorFor` fires ONLY for names in
// this CURATED table — never for an arbitrary user identifier. A random unbound
// `csv-content` matches nothing here and gets `undefined` back (no hint). This
// is deliberate: the manifold's scope/tool-suggestion doors own general "did you
// mean this OTHER binding in scope" — this table owns exactly one thing, cross-
// dialect Lisp fame.
//
// SEEDED FROM (per the task that created this file):
//   • env/polyglot.ts            — the real, bound cross-dialect implementations.
//   • env/polyglot-rich-errors/stubs.ts — the well-known-but-unimplemented doors.
//   • env/srfi/srfi-stubs.ts     — the SRFI/R7RS spec-omission doors.
//   • general Lisp fame          — R7RS/SRFI-1 core (car/cdr/map/filter/reduce/…)
//     verified bound by grep, PLUS one genuine gap SRFI-1's bare `fold` (left
//     fold) — only `fold-right` and `reduce` are bound here, so `fold` is
//     "famous" (neither bound nor stubbed) with an honest redirect.
//
// Every `status` was verified by grep against the current source before being
// recorded here — never assumed from "5.x is recent"-style approximation (see
// `.claude/rules/npm-version-pinning.md`'s sibling discipline: verify, don't guess).

/** Where the record's `status` puts a well-known name relative to THIS runtime. */
export type WellKnownStatus =
  /** A real binding exists under this exact name (env/polyglot.ts, an R7RS/SRFI pack, or resolver-structural like car/cdr). */
  | "bound"
  /** Bound to a `symbol.notImplemented` door (stubs.ts or srfi-stubs.ts) — referencing it resolves fine; CALLING it throws the teaching door. */
  | "stubbed"
  /** Famous across the Lisp family, genuinely absent here — neither bound nor doored. A bare reference throws plain "Unbound variable" today (this registry is what enriches that). */
  | "famous";

export interface WellKnownSymbolEntry {
  /** The canonical spelling — the form recorded here IS the canonical form (no separate alias field: one row per distinct famous spelling). */
  readonly name: string;
  /** Dialect(s)/spec(s) this spelling is famous in — free-form labels (e.g. "Clojure", "Common Lisp", "Racket", "SRFI-1", "R7RS"). */
  readonly dialects: readonly string[];
  readonly status: WellKnownStatus;
  /** A short redirect/gist — required for "stubbed"/"famous" (where does the model go instead), optional for "bound" (rarely needed, the fix is just the typo). */
  readonly note?: string;
}

// ── 1. env/polyglot.ts — real, bound implementations ─────────────────────────
const POLYGLOT_BOUND: readonly WellKnownSymbolEntry[] = [
  { name: "nil", dialects: ["LIPS"], status: "bound" },
  { name: "->", dialects: ["Clojure"], status: "bound" },
  { name: "->>", dialects: ["Clojure"], status: "bound" },
  { name: "~>", dialects: ["Racket"], status: "bound" },
  { name: "~>>", dialects: ["Racket"], status: "bound" },
  { name: "compose", dialects: ["Clojure", "R7RS-ish"], status: "bound" },
  { name: "comp", dialects: ["Clojure"], status: "bound", note: "alias of compose" },
  { name: "pipe", dialects: ["FP idiom"], status: "bound" },
  { name: "flow", dialects: ["Ramda/Lodash"], status: "bound", note: "alias of pipe" },
  { name: "str", dialects: ["Clojure"], status: "bound" },
  { name: "get-in", dialects: ["Clojure"], status: "bound" },
  { name: "assoc-in", dialects: ["Clojure"], status: "bound" },
  { name: "update-in", dialects: ["Clojure"], status: "bound" },
  { name: "zipmap", dialects: ["Clojure"], status: "bound" },
  { name: "frequencies", dialects: ["Clojure"], status: "bound" },
  { name: "group-by", dialects: ["Clojure"], status: "bound" },
  { name: "partial", dialects: ["Clojure"], status: "bound" },
  { name: "juxt", dialects: ["Clojure"], status: "bound" },
  { name: "mapv", dialects: ["Clojure"], status: "bound" },
  { name: "filterv", dialects: ["Clojure"], status: "bound" },
  { name: "conj", dialects: ["Clojure"], status: "bound" },
  { name: "into", dialects: ["Clojure"], status: "bound" },
  { name: "rest", dialects: ["Clojure"], status: "bound" },
  { name: "empty?", dialects: ["Clojure"], status: "bound" },
  { name: "mapcar", dialects: ["Common Lisp"], status: "bound", note: "alias of map" },
  { name: "remove-if", dialects: ["Common Lisp"], status: "bound" },
  { name: "remove-if-not", dialects: ["Common Lisp"], status: "bound" },
  { name: "dict", dialects: ["arrival-native"], status: "bound" },
  { name: "@", dialects: ["arrival-native"], status: "bound" },
  { name: "@?", dialects: ["arrival-native"], status: "bound" },
  { name: "@keys", dialects: ["arrival-native"], status: "bound" },
  { name: "first", dialects: ["SRFI-1", "Clojure"], status: "bound" },
  { name: "curry", dialects: ["SRFI-235-adjacent"], status: "bound" },
];

// ── 2. env/polyglot-rich-errors/stubs.ts — well-known but unimplemented ──────
const CROSS_DIALECT_STUBBED: readonly WellKnownSymbolEntry[] = [
  { name: "type-of", dialects: ["Common Lisp"], status: "stubbed", note: "use the granular type predicates (pair?/string?/number?/…) instead" },
  { name: "<>", dialects: ["SRFI-26", "SQL"], status: "stubbed", note: "cut placeholder only inside (cut …), or use (not (equal? a b))" },
  { name: "make-hash", dialects: ["Racket"], status: "stubbed", note: "dicts are native — build with {:key value …} or (dict …)" },
  { name: "make-hasheq", dialects: ["Racket"], status: "stubbed", note: "dicts are native — build with {:key value …} or (dict …)" },
  { name: "hash-ref", dialects: ["Racket"], status: "stubbed", note: "dicts are native — read with (:key d) or (@ d :key)" },
  { name: "gethash", dialects: ["Common Lisp"], status: "stubbed", note: "dicts are native — read with (:key d) or (@ d :key)" },
  { name: "getf", dialects: ["Common Lisp"], status: "stubbed", note: "dicts are native — read with (:key d) or (@ d :key)" },
  { name: "println", dialects: ["Clojure"], status: "stubbed", note: "IO is omitted by design — return the value, it flows to the caller" },
  { name: "print", dialects: ["Clojure"], status: "stubbed", note: "IO is omitted by design — return the value, it flows to the caller" },
  { name: "setf", dialects: ["Common Lisp"], status: "stubbed", note: "pure sandbox, no mutation — rebind with (define …) instead" },
  { name: "defun", dialects: ["Common Lisp"], status: "stubbed", note: "use (define (name args …) body …)" },
  { name: "loop", dialects: ["Common Lisp"], status: "stubbed", note: "use named let, map/filter/reduce, or SRFI-1 iota/unfold/fold-right" },
  { name: "nreverse", dialects: ["Common Lisp"], status: "stubbed", note: "reverse (R7RS) is bound and non-destructive" },
  { name: "for/list", dialects: ["Racket"], status: "stubbed", note: "use (map (lambda (x) body) lst)" },
  { name: "for/fold", dialects: ["Racket"], status: "stubbed", note: "use (reduce (lambda (x acc) body) initial lst)" },
];

// ── 3. env/srfi/srfi-stubs.ts — SRFI/R7RS spec omissions ─────────────────────
const SRFI_R7RS_STUBBED: readonly WellKnownSymbolEntry[] = [
  { name: "make-hash-table", dialects: ["SRFI-69", "SRFI-125"], status: "stubbed", note: "dicts are native — build with {:key value …} or (dict …)" },
  { name: "hash-table?", dialects: ["SRFI-69"], status: "stubbed", note: "use dict?" },
  { name: "hash-table-ref", dialects: ["SRFI-69"], status: "stubbed", note: "read with (:key d) or (@ d :key)" },
  { name: "hash-table-ref/default", dialects: ["SRFI-69"], status: "stubbed", note: "read with (:key d) or (@ d :key)" },
  { name: "hash-table-set!", dialects: ["SRFI-69"], status: "stubbed", note: "dicts are immutable — rebuild a fresh dict instead" },
  { name: "hash-table-delete!", dialects: ["SRFI-69"], status: "stubbed", note: "dicts are immutable — rebuild a fresh dict instead" },
  { name: "hash-table-update!", dialects: ["SRFI-69"], status: "stubbed", note: "dicts are immutable — rebuild a fresh dict instead" },
  { name: "hash-table->alist", dialects: ["SRFI-69"], status: "stubbed", note: "fold over (@keys d)" },
  { name: "alist->hash-table", dialects: ["SRFI-69"], status: "stubbed", note: "use (dict …) with interleaved key/value args" },
  { name: "hash-table-keys", dialects: ["SRFI-69"], status: "stubbed", note: "use (@keys d)" },
  { name: "hash-table-values", dialects: ["SRFI-69"], status: "stubbed", note: "fold over (@keys d)" },
  { name: "hash-table-walk", dialects: ["SRFI-69"], status: "stubbed", note: "fold over (@keys d)" },
  { name: "hash-table-fold", dialects: ["SRFI-69"], status: "stubbed", note: "fold over (@keys d)" },
  { name: "hash-table-count", dialects: ["SRFI-69"], status: "stubbed", note: "use (length (@keys d))" },
  { name: "hash-table-exists?", dialects: ["SRFI-69"], status: "stubbed", note: "use @?" },
  { name: "hash-table-contains?", dialects: ["SRFI-125"], status: "stubbed", note: "use @?" },
  { name: "call-with-input-file", dialects: ["R7RS"], status: "stubbed", note: "files arrive through tools, not streams" },
  { name: "call-with-output-file", dialects: ["R7RS"], status: "stubbed", note: "files arrive through tools, not streams" },
  { name: "with-input-from-file", dialects: ["R7RS"], status: "stubbed", note: "files arrive through tools, not streams" },
  { name: "with-output-to-file", dialects: ["R7RS"], status: "stubbed", note: "files arrive through tools, not streams" },
  { name: "open-input-file", dialects: ["R7RS"], status: "stubbed", note: "files arrive through tools, not streams" },
  { name: "open-output-file", dialects: ["R7RS"], status: "stubbed", note: "files arrive through tools, not streams" },
  { name: "with-open-file", dialects: ["Common Lisp"], status: "stubbed", note: "files arrive through tools, not streams" },
  { name: "random-integer", dialects: ["SRFI-27"], status: "stubbed", note: "ambient non-determinism omitted by design — pass a seed/choice in explicitly" },
  { name: "random-real", dialects: ["SRFI-27"], status: "stubbed", note: "ambient non-determinism omitted by design — pass a seed/choice in explicitly" },
  { name: "random-source-make-integers", dialects: ["SRFI-27"], status: "stubbed", note: "ambient non-determinism omitted by design" },
  { name: "char-set", dialects: ["SRFI-14"], status: "stubbed", note: "use a char or one-arg predicate, e.g. char-numeric?" },
  { name: "char-set?", dialects: ["SRFI-14"], status: "stubbed", note: "use a char or one-arg predicate" },
  { name: "char-set-contains?", dialects: ["SRFI-14"], status: "stubbed", note: "use a char or one-arg predicate" },
  { name: "string->char-set", dialects: ["SRFI-14"], status: "stubbed", note: "use a char or one-arg predicate" },
  { name: "char-set:whitespace", dialects: ["SRFI-14"], status: "stubbed", note: "use char-whitespace? as the predicate arg" },
  { name: "char-set:alphabetic", dialects: ["SRFI-14"], status: "stubbed", note: "use char-alphabetic? as the predicate arg" },
  { name: "char-set:numeric", dialects: ["SRFI-14"], status: "stubbed", note: "use char-numeric? as the predicate arg" },
  { name: "current-date", dialects: ["SRFI-19"], status: "stubbed", note: "the clock is ambient — timestamps arrive in tool results" },
  { name: "current-time", dialects: ["SRFI-19"], status: "stubbed", note: "the clock is ambient — timestamps arrive in tool results" },
  { name: "date->string", dialects: ["SRFI-19"], status: "stubbed", note: "the clock is ambient — format the tool-provided timestamp as a plain string" },
  { name: "string->date", dialects: ["SRFI-19"], status: "stubbed", note: "the clock is ambient" },
  { name: "time-utc->date", dialects: ["SRFI-19"], status: "stubbed", note: "the clock is ambient" },
  { name: "current-julian-day", dialects: ["SRFI-19"], status: "stubbed", note: "the clock is ambient" },
  {
    name: "string-filter",
    dialects: ["SRFI-13"],
    status: "stubbed",
    note: "(list->string (filter pred (string->list s))) using bound filter/string->list/list->string",
  },
  { name: "list->set", dialects: ["SRFI-113"], status: "stubbed", note: "no set type here — delete-duplicates + member cover de-dup/membership on lists" },
  { name: "set-contains?", dialects: ["SRFI-113"], status: "stubbed", note: "no set type here — use member on a list" },
  { name: "call-with-input-string", dialects: ["R7RS", "SRFI-6"], status: "stubbed", note: "string ports omitted — operate on the string directly" },
];

// ── 4. General Lisp fame — R7RS/SRFI-1 core, verified bound by grep ──────────
const GENERAL_FAME: readonly WellKnownSymbolEntry[] = [
  { name: "car", dialects: ["R7RS"], status: "bound", note: "resolver-structural (c[ad]+r composition), not a capability symbol" },
  { name: "cdr", dialects: ["R7RS"], status: "bound", note: "resolver-structural (c[ad]+r composition), not a capability symbol" },
  { name: "cons", dialects: ["R7RS"], status: "bound" },
  { name: "map", dialects: ["R7RS"], status: "bound" },
  { name: "filter", dialects: ["SRFI-1"], status: "bound" },
  { name: "reduce", dialects: ["SRFI-1"], status: "bound", note: "left fold, fn(element, acc) convention" },
  { name: "fold-right", dialects: ["SRFI-1"], status: "bound" },
  { name: "append", dialects: ["R7RS"], status: "bound" },
  { name: "reverse", dialects: ["R7RS"], status: "bound" },
  { name: "length", dialects: ["R7RS"], status: "bound" },
  { name: "null?", dialects: ["R7RS"], status: "bound" },
  { name: "pair?", dialects: ["R7RS"], status: "bound" },
  { name: "string?", dialects: ["R7RS"], status: "bound" },
  { name: "number?", dialects: ["R7RS"], status: "bound" },
  { name: "symbol?", dialects: ["R7RS"], status: "bound" },
  { name: "boolean?", dialects: ["R7RS"], status: "bound" },
  { name: "vector?", dialects: ["R7RS"], status: "bound" },
  { name: "procedure?", dialects: ["R7RS"], status: "bound" },
  { name: "dict?", dialects: ["Racket-ish"], status: "bound" },
  { name: "apply", dialects: ["R7RS"], status: "bound" },
  { name: "iota", dialects: ["SRFI-1"], status: "bound" },
  { name: "unfold", dialects: ["SRFI-1"], status: "bound" },
  { name: "delete-duplicates", dialects: ["SRFI-1"], status: "bound" },
  { name: "member", dialects: ["R7RS"], status: "bound" },
  { name: "assoc", dialects: ["R7RS"], status: "bound" },
  { name: "take", dialects: ["SRFI-1"], status: "bound" },
  { name: "drop", dialects: ["SRFI-1"], status: "bound" },
  { name: "last", dialects: ["SRFI-1"], status: "bound" },
  { name: "last-pair", dialects: ["SRFI-1"], status: "bound" },
  { name: "partition", dialects: ["SRFI-1"], status: "bound" },
  { name: "count", dialects: ["SRFI-1"], status: "bound" },
  { name: "concatenate", dialects: ["SRFI-1"], status: "bound" },
  { name: "list-tabulate", dialects: ["SRFI-1"], status: "bound" },
  { name: "string-index", dialects: ["SRFI-13"], status: "bound" },
  { name: "string-count", dialects: ["SRFI-13"], status: "bound" },
  { name: "string-trim", dialects: ["SRFI-13"], status: "bound" },
  { name: "string-split", dialects: ["SRFI-152"], status: "bound" },
  { name: "string-join", dialects: ["SRFI-13"], status: "bound" },
  { name: "string-append", dialects: ["R7RS"], status: "bound" },
  // The one genuine gap: SRFI-1's bare LEFT fold has no binding of its own here —
  // only `reduce` (same fold shape, different arg order/name) and `fold-right`
  // are bound. Verified by grep (no `(define (fold ` / `"fold":` in env/**).
  {
    name: "fold",
    dialects: ["SRFI-1"],
    status: "famous",
    note: "not bound under this name — use reduce (fn(element, acc), left fold) or fold-right (right-associative)",
  },
];

/** The full curated table — every well-known cross-dialect / SRFI / R7RS symbol
 *  this registry knows about, one row per canonical spelling. */
export const WELL_KNOWN_SYMBOLS: readonly WellKnownSymbolEntry[] = [
  ...POLYGLOT_BOUND,
  ...CROSS_DIALECT_STUBBED,
  ...SRFI_R7RS_STUBBED,
  ...GENERAL_FAME,
];

const BY_NAME: ReadonlyMap<string, WellKnownSymbolEntry> = new Map(WELL_KNOWN_SYMBOLS.map((e) => [e.name, e]));

/** Lowercase + strip WORD-SEPARATOR noise only (`-`/`_`/whitespace) — collapses
 *  dash/underscore/case/spacing variance (`string_split` / `STRING-SPLIT` /
 *  `String Split` all collapse to the same key as `string-split`) so a
 *  spelling-convention miss is caught even when its raw edit distance is > 1.
 *
 *  Every OTHER character is kept, lowercased but otherwise significant — a
 *  trailing `?`/`!` is R7RS/Scheme's own predicate/mutator sigil, not separator
 *  noise (`dict` vs `dict?`, `char-set` vs `char-set?` are genuinely distinct
 *  bound symbols), and the punctuation-only spellings (`->`, `->>`, `~>`, `~>>`,
 *  `@`, `@?`, `<>`) are the ENTIRE identity of those names — stripping every
 *  non-alphanumeric character (the previous rule) collapsed all seven to the
 *  empty string and merged the two `?`-suffixed pairs, silently keeping only the
 *  LAST-inserted entry per colliding key in `BY_CANONICAL` below. Stripping only
 *  the separator characters keeps every one of those distinct (`->` → `>`,
 *  `->>` → `>>`, `~>` stays `~>`, `~>>` stays `~>>`, `@` stays `@`, `@?` stays
 *  `@?`, `<>` stays `<>`) while leaving the word-form collapsing intact. */
function canonicalize(s: string): string {
  return s.toLowerCase().replace(/[-_\s]/g, "");
}

const BY_CANONICAL: ReadonlyMap<string, WellKnownSymbolEntry> = new Map(WELL_KNOWN_SYMBOLS.map((e) => [canonicalize(e.name), e]));

/** Levenshtein edit distance, capped: returns as soon as it's provably > `max`,
 *  since `richErrorFor` only ever asks "is this ≤ 1 away". */
function editDistanceAtMost(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1; // whole row already past the cap
    prev = cur;
  }
  return prev[n];
}

/**
 * `richErrorFor` — the typo-enrichment gate. Given an UNBOUND name, return a
 * "did you mean …?" hint iff it is a close typo of a well-known cross-dialect
 * symbol; `undefined` otherwise (the caller falls back to the plain "Unbound
 * variable" message unchanged).
 *
 * Two gates, either fires:
 *   1. CANONICAL-FORM match — same letters/digits once case and `-`/`_`/space
 *      are stripped (a spelling-convention miss: `string_split`, `StringSplit`).
 *   2. EDIT-DISTANCE ≤ 1 on the raw strings — a genuine one-character typo
 *      (`reduse` → `reduce`, `string-splt` → `string-split`).
 *
 * An EXACT match (`name` already equals a registered entry's `name`) never
 * reaches here for a "bound" entry (it would already have resolved) and is
 * explicitly skipped — this function is for NEAR misses, not the symbol itself.
 */
export function richErrorFor(unboundName: string): string | undefined {
  const exact = BY_NAME.get(unboundName);
  if (exact) return undefined; // already resolves to this exact registered entry — nothing to suggest

  const canonicalHit = BY_CANONICAL.get(canonicalize(unboundName));
  const entry = canonicalHit ?? nearestByEditDistance(unboundName);
  if (!entry) return undefined;

  return describeSuggestion(entry);
}

function nearestByEditDistance(unboundName: string): WellKnownSymbolEntry | undefined {
  // Length floor: distance-1 between short names is noise, not a typo signal — EVERY
  // 1-char name is one substitution from every 1-char entry (`a` → `@`), so an unbound
  // single-letter variable would get a wrong "did you mean `@`" and SHADOW the doors
  // that actually own that case (scope-confusion, quoting). A wrong hint is poison;
  // require enough structure on both sides before suggesting.
  if (unboundName.length < 3) return undefined;
  let best: { entry: WellKnownSymbolEntry; distance: number } | undefined;
  for (const entry of WELL_KNOWN_SYMBOLS) {
    if (entry.name.length < 3) continue;
    const distance = editDistanceAtMost(unboundName, entry.name, 1);
    if (distance <= 1 && (!best || distance < best.distance)) {
      best = { entry, distance };
      if (distance === 0) break; // canonicalize already ruled out an exact match above; won't happen, but nothing closer exists
    }
  }
  return best?.entry;
}

function describeSuggestion(entry: WellKnownSymbolEntry): string {
  const dialectStr = entry.dialects.join("/");
  switch (entry.status) {
    case "bound":
      return `did you mean \`${entry.name}\` (${dialectStr})? it is bound here${entry.note ? ` — ${entry.note}` : ""}`;
    case "stubbed":
      return `did you mean \`${entry.name}\` (${dialectStr})? it is a well-known symbol this runtime doors rather than implements${entry.note ? ` — ${entry.note}` : ""}`;
    case "famous":
      return `did you mean \`${entry.name}\` (${dialectStr})? it is a well-known symbol but is not implemented in this runtime${entry.note ? ` — ${entry.note}` : ""}`;
  }
}

/**
 * `unboundVariableError` — the ONE place that builds the "Unbound variable" error
 * object, shared by every arrival-side throw site (`Environment.ts#get`,
 * `eval/Resolver.ts#resolveSynth`, `eval/evaluator.ts#resolvedBindingOrThrow`).
 * Appends `richErrorFor`'s hint to both `.message` (the thrown Error, e.g. surfaced
 * in a stack trace) and `.publicMessage` (the model/agent-facing string an MCP
 * tool surface reads) when the miss matches the well-known-symbol table; falls
 * back to the original plain wording otherwise (byte-identical to the pre-existing
 * message when there is no hint, so this is a pure addition, never a regression).
 *
 * `enriched` is a THIRD, STRUCTURED signal alongside the two wording fields:
 * unambiguously true iff a rich did-you-mean suffix was appended (`hint !==
 * undefined`), false for a bare unbound-variable throw. It exists so a consumer
 * that needs "did arrival already enrich this?" can ask a typed boolean instead of
 * re-deriving the same decision by sniffing the SHAPE of `.message` (e.g. a
 * `raw.startsWith(...) && raw.length > bareWall.length` string-length check) — a
 * wording change to either `.message` or `.publicMessage` can no longer silently
 * break that decision, because `enriched` doesn't depend on either string's
 * content. (`second-foundation/arrival-manifold`'s `manifold-tool.ts` currently
 * does exactly that sniff, keyed off `.message`; wiring it to read `.enriched`
 * instead is a separate, later change — see
 * docs/working-proposals/arrival-manifold-decomposition-2026-07-05.md §5.4.)
 */
export function unboundVariableError(name: string): Error & { publicMessage: string; enriched: boolean } {
  const hint = richErrorFor(name);
  const message = hint ? `Unbound variable \`${name}' — ${hint}` : `Unbound variable \`${name}'`;
  const publicMessage = hint
    ? `symbol ${name} does not exist - look at list of available functions at tool description (${hint})`
    : `symbol ${name} does not exist - look at list of available functions at tool description`;
  return Object.assign(new Error(message), { publicMessage, enriched: hint !== undefined });
}
