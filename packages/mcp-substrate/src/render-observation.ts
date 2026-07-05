// render-observation — brace-style observation rendering: dict/list heads print as
// `{:k v ...}` / `[a b ...]` instead of the constructor-call form `(dict :k v ...)` /
// `(list a b ...)`. Closes the round-trip: the arrival reader already ACCEPTS this
// notation as a first-class literal grammar (docs/working-proposals/
// arrival-curly-vector-literals.md), so a model now reads results back in exactly the
// notation it writes them in. MEASURED: ~9.3% token saving on 1,597 real tau-bench
// observations (tiktoken o200k_base) — the `(dict `/`(list ` heads cost 2-3 tokens per
// collection vs 1 for `{`/`[`.
//
// Implementation: a FORMATTER over arrival-serializer's `toSExpr(obj)` intermediate
// tree (exported — already normalizes every arrival/LIPS value shape: AExact/AInexact,
// AString quoting, APair→list, Values, Map/Set, cycle detection, truncation markers).
// This module owns exactly two head renderings ("dict" → braces, "list" → brackets);
// every OTHER head (map/set/values/a custom Symbol.toSExpr tag) keeps its existing
// `(head ...)` shape — ported from formatSExpr's own generic-application logic
// (serializer.ts) so those heads still recurse through THIS module's brace rendering
// for any nested dict/list children (formatSExpr's own version instead recurses into
// itself, i.e. stays parens all the way down — see e.g. `(values (list ..) (list ..))`,
// which must come back `(values [..] [..])`, not fully un-braced). Leaf/primitive
// values (strings, numbers, quoted/tagged/truncation markers) delegate to formatSExpr
// wholesale — it already implements those exactly; no reason to fork them.

import { formatSExpr, type SerializeOpts, toSExprString, type SExpr } from "@here.build/arrival-serializer";

import type { RemedyMode, TriggerClass } from "./competence.js";

/** Default total observation budget — same order of magnitude as arrival-serializer's own
 *  DEFAULT_TOTAL (that constant isn't exported, so this is a local twin). Overridable per
 *  server via the `observation.maxTotalChars` config knob (config.ts → manifold-tool.ts). */
export const DEFAULT_OBSERVATION_MAX_TOTAL_CHARS = 40_000;

/** Streaming-cap seeds for the normal (under-budget) case: generous enough that a real
 *  tool observation is never truncated below the total budget (a single string may consume
 *  the whole budget; 10k items of anything overflow it), so the caps only ever BITE via
 *  the shrink-to-fit loop once the render actually exceeds `maxTotalChars`. */
const SEED_MAX_ITEMS = 10_000;

/** arrival-serializer's truncation marker (module-private there; shared by `Symbol.for`
 *  registry key). A capped dict's `+N more of TOTAL` marker arrives as a trailing ODD
 *  entry in the `(dict …)` tail — `formatDict` must render it verbatim instead of
 *  dropping it as a key with no value. */
const TRUNCATED_MARKER = Symbol.for("arrival:truncated");
const isTruncationMarker = (x: SExpr): boolean =>
  typeof x === "object" && x !== null && !Array.isArray(x) && TRUNCATED_MARKER in x;

const isKeyToken = (x: SExpr): boolean => typeof x === "string" && x.startsWith(":");

/** A dict key from `toSExpr` is always the string `":name"` (toSExprDispatch always
 *  emits `` `:${key}` ``, for both plain objects and Maps — serializer.ts's plain-object
 *  and Map branches never emit a bare/quoted string key). Render it as the bare
 *  keyword `:name` when `name` reads back as one — the same "looks like a symbol"
 *  heuristic formatSExpr itself uses for primitive strings (`/^[a-z][\w-]*$/i`,
 *  serializer.ts ~line 529) — else fall back to the OTHER key shape the `{}` reader
 *  admits, a quoted string (docs/working-proposals/arrival-curly-vector-literals.md),
 *  so an odd key (spaces, punctuation) still round-trips instead of emitting an
 *  unreadable bare token. */
function renderKey(key: SExpr): string {
  if (typeof key === "string" && key.startsWith(":")) {
    const name = key.slice(1);
    if (/^[a-z][\w-]*$/i.test(name)) return key;
    const escaped = name.replaceAll('"', String.raw`\"`);
    return `"${escaped}"`;
  }
  return format(key, 0);
}

function formatDict(tail: SExpr[]): string {
  const pairs: string[] = [];
  for (let i = 0; i < tail.length; i += 2) {
    const item = tail[i] as SExpr;
    // A capped dict carries a trailing truncation marker as one ODD entry — render it
    // verbatim (a `#| … |#` comment, so the braces still parse), never pair it with a value.
    if (isTruncationMarker(item)) {
      pairs.push(formatSExpr(item, 0));
      i -= 1; // consumed ONE entry, not a pair
      continue;
    }
    const value = tail[i + 1];
    if (value !== undefined) pairs.push(`${renderKey(item)} ${format(value, 0)}`);
  }
  return `{${pairs.join(" ")}}`;
}

/** One-line rendering. `headWord === null` ⇒ bracket collection (no word); otherwise
 *  the classic `(word ...)` operator-application shape. */
function renderFlat(headWord: string | null, tail: SExpr[]): string {
  const strTail = tail.map((item) => format(item, 0)).join(" ");
  if (headWord === null) return `[${strTail}]`;
  return strTail ? `(${headWord} ${strTail})` : `(${headWord})`;
}

/** Multi-line rendering — ported from formatSExpr's generic complex-array branch
 *  (serializer.ts, the final `else` in its array handling), recursing through
 *  `format` instead of `formatSExpr` so nested dict/list keep braces/brackets at any
 *  depth. */
function renderBlock(headWord: string | null, tail: SExpr[], indent: number): string {
  const spaces = " ".repeat(indent);
  const strTail = tail
    .map((item, index) => {
      const formatted = format(item, indent + 2);
      // A `:key` groups with the NEXT item only when that item is a real VALUE (not
      // another keyword) — consecutive keywords are standalone flags and must stand
      // on their own line.
      if (isKeyToken(item) && index + 1 < tail.length) {
        const nextItem = tail[index + 1] as SExpr;
        const nextFormatted = format(nextItem, 0);
        if (!isKeyToken(nextItem) && !Array.isArray(nextItem) && nextFormatted.length < 40) return null;
      }
      // Emit a `:key value` pair: the preceding key was skipped above, so this value
      // carries it on one line.
      const prev = index > 0 ? tail[index - 1] : undefined;
      if (
        prev !== undefined &&
        isKeyToken(prev) &&
        !isKeyToken(item) &&
        !Array.isArray(item) &&
        formatted.length < 40
      ) {
        return `${spaces}  ${format(prev, 0)} ${formatted}`;
      }
      return `${spaces}  ${formatted}`;
    })
    .filter((line): line is string => line !== null)
    .join("\n");
  if (headWord === null) return strTail ? `[\n${strTail}]` : "[]";
  return strTail ? `(${headWord}\n${strTail})` : `(${headWord})`;
}

function formatList(tail: SExpr[], indent: number): string {
  if (tail.length === 0) return "[]";
  // Mirrors formatSExpr's dedicated "list" one-liner heuristic (serializer.ts, the
  // reference/definition/diagnostic/symbol/type/list block): stay on one line unless
  // a string is long or a nested structure is non-trivial.
  const hasLongString = tail.some((item) => typeof item === "string" && item.length > 80 && !item.startsWith(":"));
  const hasComplexStructure = tail.some((item) => Array.isArray(item) && item.length > 3);
  if (!hasLongString && !hasComplexStructure) return renderFlat(null, tail);
  const isSimple = tail.length <= 3 && tail.every((item) => !Array.isArray(item) || item.length <= 2);
  return isSimple ? renderFlat(null, tail) : renderBlock(null, tail, indent);
}

/** formatSExpr's "map" head — head-preserving, word+parens; ported so nested dict/list
 *  values still get braces/brackets via `format`. */
function formatMap(strHead: string, tail: SExpr[], indent: number): string {
  const pairs: string[] = [];
  for (let i = 0; i < tail.length; i += 2) {
    const keyItem = tail[i] as SExpr;
    if (isTruncationMarker(keyItem)) {
      // Same trailing-odd-marker handling as formatDict — never drop a truncation note.
      pairs.push(formatSExpr(keyItem, 0));
      i -= 1;
      continue;
    }
    const valueItem = tail[i + 1];
    if (valueItem === undefined) continue;
    const key = format(keyItem, 0);
    const isComplexValue = Array.isArray(valueItem) || (typeof valueItem === "string" && valueItem.length > 40);
    const value = isComplexValue ? format(valueItem, indent + 2 + key.length + 1) : format(valueItem, 0);
    pairs.push(`${key} ${value}`);
  }
  const totalLength = pairs.reduce((sum, p) => sum + p.length, 0) + pairs.length * 2;
  if (pairs.length <= 2 && totalLength < 60) return `(${strHead} ${pairs.join(" ")})`;
  const spaces = " ".repeat(indent);
  const indentedPairs = pairs.map((p) => `${spaces}  ${p}`).join("\n");
  return `(${strHead}\n${indentedPairs})`;
}

/** formatSExpr's `Stateful`/`Calculator` unquoted-bare-symbol special case, or `null`
 *  when this node doesn't match that shape (the caller falls through to the generic
 *  path). Vanishingly rare in observation data — ported for parity, not because
 *  manifold results are expected to hit it. */
function formatStatefulLike(head: SExpr, strHead: string, tail: SExpr[]): string | null {
  if (typeof head !== "string" || head.startsWith(":") || head.startsWith('"')) return null;
  if (head !== "Stateful" && head !== "Calculator") return null;
  const isSymbol = tail.some((item) => typeof item === "string" && !item.startsWith(":") && !item.includes(" "));
  if (!isSymbol) return null;
  const formattedTail = tail
    .map((item) => (typeof item === "string" && !item.startsWith(":") && !item.includes(" ") ? item : format(item, 0)))
    .join(" ");
  return `(${strHead} ${formattedTail})`;
}

/** Everything except dict/list — ported from formatSExpr's generic-head path
 *  (serializer.ts), minus the dict/list special cases (handled above, before this is
 *  ever reached), recursing through `format` so a rare nested dict/list under e.g.
 *  `values`/`map` still gets braces/brackets. */
function formatOther(head: SExpr, tail: SExpr[], indent: number): string {
  const strHead = typeof head === "string" && !head.startsWith(":") ? head : format(head, 0);

  if (head === "map") return formatMap(strHead, tail, indent);
  if (strHead === "<function>") return "<function>";

  const statefulLike = formatStatefulLike(head, strHead, tail);
  if (statefulLike !== null) return statefulLike;

  if (head === "reference" || head === "definition" || head === "diagnostic" || head === "symbol" || head === "type") {
    const hasLongString = tail.some((item) => typeof item === "string" && item.length > 80 && !item.startsWith(":"));
    const hasComplexStructure = tail.some((item) => Array.isArray(item) && item.length > 3);
    if (!hasLongString && !hasComplexStructure) return renderFlat(strHead, tail);
  }

  const isSimple = tail.length <= 3 && tail.every((item) => !Array.isArray(item) || item.length <= 2);
  return isSimple ? renderFlat(strHead, tail) : renderBlock(strHead, tail, indent);
}

/** Formatter over `toSExpr`'s intermediate tree: "dict"/"list" heads render braced/
 *  bracketed; every other node delegates as documented in the file header. */
function format(node: SExpr, indent = 0): string {
  if (!Array.isArray(node)) return formatSExpr(node, indent);
  if (node.length === 0) return "()";
  const [head, ...tail] = node;
  if (head === "dict") return formatDict(tail);
  if (head === "list") return formatList(tail, indent);
  return formatOther(head as SExpr, tail, indent);
}

/**
 * Render an arrival `exec()` result the same way the model WRITES collections — the
 * `{}`/`[]` reader grammar it already emits itself — instead of the constructor-call
 * form `(dict ...)`/`(list ...)`. Every rendered observation still PARSES under the
 * committed grammar (round-trip test: __tests__/render-observation.test.ts).
 *
 * Truncation: this formatter rides `toSExprString`'s OWN caps machinery via
 * `SerializeOpts.format` — streaming per-collection/per-string caps, the fair
 * shrink-to-fit loop, and `#| +N more of TOTAL |#` markers all apply NATIVELY to the
 * brace rendering (this replaced the earlier post-check that fell back to the parens
 * s-expr form past 40k chars). The seeds are sized so the caps only ever bite once the
 * total budget is actually exceeded: a single string may span the whole budget, and any
 * collection past SEED_MAX_ITEMS items overflows it anyway. An under-budget observation
 * renders byte-identically to the uncapped formatter.
 */
export function renderObservation(
  value: unknown,
  opts: {
    maxTotalChars?: number;
    /** COMPETENCE v2 (competence.ts): per-class remedy rendering mode — see
     *  arrival-serializer's `SerializeOpts.collectionRemedyMode`/`stringRemedyMode`. Absent ⇒
     *  "verbose" (unchanged legacy behaviour: the remedy clause always shows when its
     *  collection/string actually capped). */
    collectionRemedyMode?: RemedyMode;
    stringRemedyMode?: RemedyMode;
    /** Feedback fired when a class's remedy clause actually rendered — see the serializer's
     *  own `onRemedyRendered` for the exact firing rule. Absent ⇒ no feedback (the
     *  gradient-tracking caller, competence.ts, always passes one). */
    onRemedyRendered?: (cls: TriggerClass) => void;
    /** A/B measurement knob (see arrival-serializer's `SerializeOpts.truncationBanner`):
     *  "full" (default when unset) renders the reduced-output banner exactly as before;
     *  "none" silences it — the caps/shrink themselves are UNCHANGED, only the announcement
     *  is dropped. Threaded to BOTH rendering paths below: the collection/dict/list path
     *  (via `observationCaps`, which forwards it into `SerializeOpts`) and this function's
     *  OWN raw-top-level-string shortcut, whose `#| ⚠ output reduced: +N more chars ... |#`
     *  note is a second, independent emission site that must ALSO vanish under "none" — a
     *  half-silenced banner (collections quiet, raw strings still noisy) would defeat the
     *  point of an honest A/B knob. */
    truncationBanner?: "full" | "none";
  } = {},
): string {
  // A top-level RAW JS string (a provenance-less native return — e.g. substring/
  // string-append over literals) hits the SExpr intermediate as a bare TOKEN and renders
  // unquoted, while the same value provenance-boxed (AString) renders quoted — breaking
  // the preamble's round-trip claim inconsistently. Normalize here: quote + escape,
  // capped like any other string. (Nested raw strings inside raw containers share the
  // token fate at the serializer level — no interpreter path produces those today.)
  //
  // This shortcut now carries the SAME string-remedy clause the serializer's own
  // truncation banner does (errors-as-doors: a truncation banner with no remedy is an
  // anti-door), routed through the identical COMPETENCE v2 gating the collection/string
  // paths use elsewhere in this file — `opts.stringRemedyMode` (verbose the first time
  // this world, compact after, suppressed once stably demonstrated) and
  // `opts.onRemedyRendered("string")` so the caller's gradient advances exactly as it
  // would for a capped-inside-a-collection string.
  if (typeof value === "string") {
    const cap = opts.maxTotalChars ?? DEFAULT_OBSERVATION_MAX_TOTAL_CHARS;
    if (value.length <= cap) return JSON.stringify(value);
    const sliced = JSON.stringify(value.slice(0, cap));
    // truncationBanner: "none" — the slice above (the actual cap enforcement) is
    // UNCHANGED; only this note's emission is skipped, no fact, no remedy, no callback.
    if ((opts.truncationBanner ?? "full") === "none") return sliced;
    const stringMode = opts.stringRemedyMode ?? "verbose";
    let remedy = "";
    if (stringMode !== "suppressed") {
      remedy =
        stringMode === "compact"
          ? ` — (substring s 0 2000) or (string-contains s "needle") to pull just the part you need`
          : " — slice the long string with substring, or scan it with string-contains, to pull just the part you need";
      opts.onRemedyRendered?.("string");
    }
    return `${sliced} #| ⚠ output reduced: +${value.length - cap} more chars${remedy} |#`;
  }
  // The `SerializeOptsPending` intersection covers the window where the serializer's
  // PUBLISHED dist .d.ts predates a SerializeOpts seam its src already has (`format`, and
  // now `collectionRemedyMode`/`stringRemedyMode`/`onRemedyRendered` — live benchmark
  // runners hold the current dist, the orchestrator rebuilds after they drain). Redundant —
  // and harmless — once the dist catches up.
  const serializeOpts: SerializeOptsPending = {
    ...observationCaps(
      opts.maxTotalChars,
      { collection: opts.collectionRemedyMode, string: opts.stringRemedyMode },
      opts.onRemedyRendered,
      opts.truncationBanner,
    ),
    format: (sexpr) => format(sexpr),
  };
  return toSExprString(value, serializeOpts);
}

/** See the `SerializeOptsPending` note above `renderObservation`: the published dist's
 *  `SerializeOpts` may not yet declare `collectionRemedyMode`/`stringRemedyMode`/
 *  `onRemedyRendered`/`truncationBanner` even though this function always sets them (as
 *  `undefined` when unset) — a structural superset, never a literal assigned where the
 *  narrower type is checked, so this widens safely regardless of which dist shape a
 *  consumer holds. */
type SerializeOptsPending = SerializeOpts & {
  format?: (sexpr: SExpr) => string;
  collectionRemedyMode?: RemedyMode;
  stringRemedyMode?: RemedyMode;
  onRemedyRendered?: (cls: TriggerClass) => void;
  truncationBanner?: "full" | "none";
};

/** The observation-budget cap set, shared by BOTH rendering modes (manifold-tool.ts's
 *  "sexpr" escape hatch passes these to `toSExprString` directly): total budget + seeds
 *  sized to only ever bite once the budget is actually exceeded — never the serializer's
 *  tighter general-purpose defaults (100 items would truncate a 150-element list that
 *  fits the budget fine). `remedy` + `onRemedyRendered` thread COMPETENCE v2's per-class
 *  gradient (competence.ts) through to the serializer's own mode options — absent ⇒
 *  unchanged behaviour (both clauses render verbose whenever their collection/string
 *  actually capped). `truncationBanner` threads the A/B silence knob the same way — absent
 *  ⇒ "full" (today's behaviour). */
export function observationCaps(
  maxTotalChars: number = DEFAULT_OBSERVATION_MAX_TOTAL_CHARS,
  remedy?: { collection?: RemedyMode; string?: RemedyMode },
  onRemedyRendered?: (cls: TriggerClass) => void,
  truncationBanner?: "full" | "none",
): SerializeOptsPending {
  return {
    maxTotalChars,
    maxItems: SEED_MAX_ITEMS,
    maxStringChars: maxTotalChars,
    collectionRemedyMode: remedy?.collection,
    stringRemedyMode: remedy?.string,
    onRemedyRendered,
    truncationBanner,
  };
}
