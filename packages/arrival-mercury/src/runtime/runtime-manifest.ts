/**
 * Runtime import census — scheme RuntimeRef symbols → where they load from.
 *
 * Two sources (not a Strategy axis):
 *  - `"stage0"` — Scheme-texture / Law-T / n-ary shapes ramda cannot mean honestly
 *  - `"ramda"`  — cold HOF/structural stdlib (R6: prefer well-known libs)
 *
 * Divergence vs interpreter is catalogued, not papered over (V: extract variance later).
 *
 * Local names are reserved at walk allocation time (`RUNTIME_LOCALS`); imported names
 * may differ (e.g. scheme `list-ref` → ramda `nth` aliased as `listRef`).
 */
export type RuntimeSource = "stage0" | "ramda";

export interface RuntimeEntry {
  /** Local JS binding (reserved in the unit; used at call sites). */
  readonly local: string;
  /** Name imported from the module (defaults equal to `local`). */
  readonly imported: string;
  readonly source: RuntimeSource;
}

const e = (local: string, source: RuntimeSource, imported: string = local): RuntimeEntry => ({
  local,
  imported,
  source,
});

/**
 * Corpus-driven + cold-stdlib map. Grow by adding a row (and a stage0 export
 * when `source === "stage0"`). Infer/mcp stay stage0 stubs (R7).
 */
export const RUNTIME_MANIFEST: Readonly<Record<string, RuntimeEntry>> = {
  // ── scheme texture / Law T / n-ary (stage0) ─────────────────────────────
  "<": e("lt", "stage0"),
  "<=": e("le", "stage0"),
  ">=": e("ge", "stage0"),
  ">": e("gt", "stage0"),
  "zero?": e("zeroP", "stage0"),
  "even?": e("evenP", "stage0"),
  "odd?": e("odd", "stage0"),
  max: e("max_", "stage0"),
  append: e("append_", "stage0"), // scheme multi-list concat ≠ ramda append(el, list)
  "null?": e("nullP", "stage0"),
  "pair?": e("pairP", "stage0"),
  "eq?": e("eqP", "stage0"),
  "eqv?": e("eqvP", "stage0"),
  "equal?": e("equalP", "stage0"),
  member: e("member", "stage0"),
  assoc: e("assoc", "stage0"),
  error: e("error", "stage0"),
  list: e("list", "stage0"),
  cons: e("cons", "stage0"),
  "string-append": e("stringAppend", "stage0"),
  "string-ci=?": e("stringCiEq", "stage0"),
  every: e("every", "stage0"), // SRFI-1 value-returning + Law T
  any: e("any", "stage0"),
  some: e("some", "stage0"),
  "+": e("plus", "stage0"),
  map: e("map", "stage0"), // n-ary zip in value position; binary call often residual
  infer: e("infer", "stage0"),
  "infer/scalar": e("inferScalar", "stage0"),
  "infer/chat/scalar": e("inferChatScalar", "stage0"),

  // max-by stays stage0: ramda maxBy is a *binary* key-comparator (arity 3 curry),
  // not list-argmax — scheme (max-by f xs) is a reduce over the list.
  "max-by": e("maxBy", "stage0"),
  // list-ref stays stage0: ramda nth is index-first; scheme is list-first.
  "list-ref": e("listRef", "stage0"),

  // ── cold stdlib → ramda (catalogue Scheme divergences in RAMDA_DIVERGENCES) ─
  // length: ramda length; local `length_` keeps reservation non-property-shaped
  length: e("length_", "ramda", "length"),
  // car/cdr value-position → ramda head/tail, local remains car/cdr
  car: e("car", "ramda", "head"),
  cdr: e("cdr", "ramda", "tail"),
};

/** scheme → local name — WalkOptions.manifest / reservation set. */
export const RUNTIME_LOCALS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(RUNTIME_MANIFEST).map(([sym, row]) => [sym, row.local])),
);

/** @deprecated name — locals map only; prefer RUNTIME_LOCALS / RUNTIME_MANIFEST. */
export const STAGE0 = RUNTIME_LOCALS;

/** Default npm specifier for ramda cold imports. */
export const RAMDA_MODULE = "ramda";

/**
 * Divergence ledger (honest, not aspirational).
 * Expand when oracle rows pin a row; do not silence by inventing shims.
 */
export const RAMDA_DIVERGENCES: readonly { symbol: string; note: string }[] = [
  {
    symbol: "length",
    note: "ramda length accepts strings/objects; scheme length is list-shaped — unproven host values may differ",
  },
  {
    symbol: "car",
    note: "ramda head on empty is undefined; scheme car on () is error — same UB class as array [0]",
  },
  {
    symbol: "cdr",
    note: "ramda tail on empty is []; scheme cdr on () is error — representation-collapse array spine",
  },
  {
    symbol: "max-by",
    note: "NOT mapped to ramda.maxBy — that is a binary key-comparator, not list argmax; stays stage0",
  },
];
