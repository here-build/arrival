/**
 * Runtime import census — scheme RuntimeRef symbols → where they load from.
 *
 * **Emit contract = loose mode** (interpreter default: `ExecOptions.strict` false).
 * Residuals and shims match nil-tolerance and sequence polymorphism, never R7RS-strict
 * throws (`PortabilityError` / car-of-() TypeError). Strict is opt-in on the interpreter
 * only — the compiler does not target it.
 *
 * Two sources (not a Strategy axis):
 *  - `"stage0"` — Scheme-texture / Law-T / n-ary / loose-nil shims
 *  - `"ramda"`  — cold HOF/structural stdlib when arity+order match loose faces
 *
 * Local names are reserved at walk allocation time (`RUNTIME_LOCALS`); imported names
 * may differ (e.g. `length` → `length as length_`).
 */
/**
 * Where a RuntimeRef loads from:
 *  - `"stage0"` / `"ramda"` — the built-in multi-source census
 *  - `"pkg"` — an npm package (capability-owned runtime subpath); set `module`
 */
export type RuntimeSource = "stage0" | "ramda" | "pkg";

export interface RuntimeEntry {
  /** Local JS binding (reserved in the unit; used at call sites). */
  readonly local: string;
  /** Name imported from the module (defaults equal to `local`). */
  readonly imported: string;
  readonly source: RuntimeSource;
  /** Required when `source === "pkg"` — npm specifier (e.g. `@…/handlebars/runtime`). */
  readonly module?: string;
}

const e = (
  local: string,
  source: RuntimeSource,
  imported: string = local,
  module?: string,
): RuntimeEntry => ({
  local,
  imported,
  source,
  ...(module === undefined ? {} : { module }),
});

/** Reference capability package — handlebars owns its dep + /runtime emit surface. */
const HBS_RUNTIME = "@inhuman.tools/arrival-env-capability-handlebars/runtime";

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

  // max-by: ramda maxBy is binary key-comparator, not list-argmax
  "max-by": e("maxBy", "stage0"),
  // list-ref: ramda nth is index-first; scheme is list-first
  "list-ref": e("listRef", "stage0"),
  // car/cdr RuntimeRef: stage0 LOOSE shims (empty → []; not ramda head → undefined)
  car: e("car", "stage0"),
  cdr: e("cdr", "stage0"),

  // ── cold stdlib → ramda (loose-friendly polymorphism) ─────────────────────
  length: e("length_", "ramda", "length"),

  // ── opt-in capability packages (reference: handlebars) ────────────────────
  // Convert→scheme (import executable) then these RuntimeRefs materialize as
  // imports from the package `/runtime` subpath — not stage0 shims.
  "template/handlebars": e("templateHandlebars", "pkg", "templateHandlebars", HBS_RUNTIME),
  "handlebars/parse": e("handlebarsParse", "pkg", "handlebarsParse", HBS_RUNTIME),
  "handlebars/run": e("handlebarsRun", "pkg", "handlebarsRun", HBS_RUNTIME),
};

/** scheme → local name — WalkOptions.manifest / reservation set. */
export const RUNTIME_LOCALS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(RUNTIME_MANIFEST).map(([sym, row]) => [sym, row.local])),
);

/** @deprecated name — locals map only; prefer RUNTIME_LOCALS / RUNTIME_MANIFEST. */
export const STAGE0 = RUNTIME_LOCALS;

/** Default npm specifier for ramda cold imports. */
export const RAMDA_MODULE = "ramda";

/** Honest notes vs interpreter (loose). Emit is not R7RS-strict. */
export const RAMDA_DIVERGENCES: readonly { symbol: string; note: string }[] = [
  {
    symbol: "length",
    note: "ramda length is polymorphic (list/vector/string) — aligned with loose length carrier",
  },
  {
    symbol: "max-by",
    note: "stage0 — ramda.maxBy is binary key-comparator, not list argmax",
  },
  {
    symbol: "list-ref",
    note: "stage0 — ramda.nth is index-first; scheme is list-first",
  },
];
