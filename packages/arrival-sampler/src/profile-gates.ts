// profile-gates.ts — the per-call tool-call PROFILE gates (kwargs + positional-keyed shapes) (pure kernel, primitive 1).
//
// A STRUCTURAL tightening enforced beside the tool-call grammar (it must fire even when a string/literal
// is being OPENED, where the oracle's `midToken` is false). The dispatcher {@link violatesProfile} is the
// one seam the re-scan and session paths share, so they stay verdict-identical. Pure scans over `next`.

import type { ToolCallProfile } from "./mask-compiler.js";
import type { RuleId } from "./rules.js";
import { trailingAtom } from "./scheme-atoms.js";

/** The kwargs-shape state at the END of `next` — the class of the IN-PROGRESS trailing top-level token and
 *  how many top-level POSITIONAL args have started (incl. that in-progress one if it is a positional).
 *  Produced by {@link scanKwargsTopLevel}; consumed by {@link violatesKwargsProfile}. */
interface KwargsTopLevel {
  /** Count of top-level POSITIONAL arguments STARTED (incl. an in-progress trailing positional). Keyword
   *  tokens and keyword-values do NOT count. */
  readonly positionalCount: number;
  /** The class of the IN-PROGRESS trailing depth-1 argument token (the one the candidate is extending),
   *  persisting while the cursor is INSIDE a nested form that opened as a depth-1 token (so an unclosed
   *  `(list …)` positional/value still reports its depth-1 class). `"none"` when the cursor is at a boundary
   *  (after whitespace / a closer) or outside the call's argument level. The (a) gate keys off this: only an
   *  in-progress over-budget `positional` violates (a `value`/`keyword` has its own rule; `none` is a
   *  boundary the structural + EOS gates own). */
  readonly inProgress: "none" | "positional" | "value" | "keyword";
  /** True iff the candidate has CLOSED the call's own paren — the outer application's depth returned to 0
   *  after it opened. Used by the (a-before) gate: closing the call while fewer than `requiredCount`
   *  positionals are placed is a premature close (the model jumped to `)` without forcing the required args).
   *  A nested-form `)` (depth back to 1, not 0) does NOT set this. */
  readonly closedCall: boolean;
}

/**
 * Scan the OUTERMOST application of `next` and classify the kwargs top-level token sequence — STRUCTURALLY,
 * independent of the oracle's `midToken` (so it fires even when a string/literal is being OPENED). Walks
 * depth-aware + string-aware from the first `(` (depth 1 = the call's argument level), skips the operator
 * (the first depth-1 token), then classifies each subsequent depth-1 token positional / keyword
 * (`:`-prefixed) / keyword-value (the token right after a keyword). The trailing token may be in progress —
 * including an UNTERMINATED string (still counted: it OPENED as a depth-1 token on its `"`). Returns the
 * state AT THE END of `next`.
 *
 * Depth-1 means relative to the call's own paren: a nested `(list "vegan")` argument is ONE depth-1 token
 * (its interior is depth ≥2 and ignored). Brackets `[ ]` `{ }` are depth delimiters too (alt-parens).
 */
type TokenKind = "" | "operator" | "positional" | "keyword" | "value";
/** The mutable scan state of {@link scanKwargsTopLevel}, kept in ONE object so the openToken/closeToken
 *  helpers mutate `st.*` — a bare `let` mutated only inside those helpers would be CFA-narrowed at the
 *  post-loop read (and flagged as an "always-x condition"); an object's fields are not. `started` is implied
 *  by `depth >= 1` after the opening `(`, so the depth-1 guards need only `depth === 1`. */
interface KwargsScan {
  depth: number;
  inStr: boolean;
  seenOperator: boolean; // the first depth-1 token (the operator) has been consumed.
  inToken: boolean; // scanning a depth-1 token's chars (incl. an open string / a descended nested form).
  positionalCount: number;
  prevArgKind: "" | "positional" | "keyword" | "value"; // class of the last COMPLETED depth-1 arg token.
  curKind: TokenKind; // class of the CURRENT (open) depth-1 token.
}

/** Open a depth-1 token, classifying it: the first is the operator; a `:`-prefixed token is a keyword; the
 *  token right after a keyword is its value; otherwise a positional (counted). */
function openKwargsToken(st: KwargsScan, firstChar: string): void {
  st.inToken = true;
  if (!st.seenOperator) {
    st.seenOperator = true;
    st.curKind = "operator";
  } else if (firstChar === ":") {
    st.curKind = "keyword";
  } else if (st.prevArgKind === "keyword") {
    st.curKind = "value";
  } else {
    st.curKind = "positional";
    st.positionalCount++;
  }
}

/** Close the current depth-1 token, recording its class as the previous-arg class (for the next `value`). */
function closeKwargsToken(st: KwargsScan): void {
  if (st.curKind === "positional" || st.curKind === "keyword" || st.curKind === "value") st.prevArgKind = st.curKind;
  st.inToken = false;
  st.curKind = "";
}

/** Step the scan over one non-string character. A depth-1 token OPENS only at the call's argument level
 *  (depth 1) when not already mid-token; a `"`/`(`/bare-atom each open one (a nested form stays "open" while
 *  the cursor descends, closing back at depth 2). One closer branch handles both a depth-1 atom's own `)` and
 *  a nested form closing at depth 2. Returns true iff this char OPENS a string (the caller sets `inStr`). */
function stepKwargsChar(st: KwargsScan, ch: string): boolean {
  const atArgLevel = st.depth === 1 && !st.inToken;
  switch (ch) {
    case '"':
      if (atArgLevel) openKwargsToken(st, '"');
      return true; // opens a string — interior skipped via inStr by the caller.
    case "(":
    case "[":
    case "{":
      if (atArgLevel) openKwargsToken(st, "(");
      st.depth++;
      return false;
    case ")":
    case "]":
    case "}":
      if ((st.depth === 2 || st.depth === 1) && st.inToken) closeKwargsToken(st);
      st.depth--;
      return false;
    default:
      // whitespace ends a depth-1 atom; any other char opens one (if at the arg level); interior chars no-op.
      if (/\s/.test(ch)) {
        if (st.depth === 1 && st.inToken) closeKwargsToken(st);
      } else if (atArgLevel) openKwargsToken(st, ch);
      return false;
  }
}

function scanKwargsTopLevel(next: string): KwargsTopLevel {
  const open = next.indexOf("(");
  if (open === -1) return { positionalCount: 0, inProgress: "none", closedCall: false };
  const st: KwargsScan = {
    depth: 0,
    inStr: false,
    seenOperator: false,
    inToken: false,
    positionalCount: 0,
    prevArgKind: "",
    curKind: "",
  };
  for (let i = open; i < next.length; i++) {
    const ch = next[i];
    if (st.inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') st.inStr = false; // the string continues until a delimiter/space.
      continue;
    }
    if (stepKwargsChar(st, ch)) st.inStr = true;
  }
  // The in-progress trailing depth-1 token's class. `inToken` stays set while the cursor is INSIDE a nested
  // form that opened as a depth-1 token (depth ≥2), so an unclosed `(list …)` 4th positional still reports
  // "positional" even though the cursor is one level down. A boundary cursor (no open token) ⇒ "none".
  const inProgress: "none" | "positional" | "value" | "keyword" =
    st.inToken && (st.curKind === "positional" || st.curKind === "value" || st.curKind === "keyword")
      ? st.curKind
      : "none";
  // The scan started at the call's `(` with depth 0, which the `(` raised to 1. Depth back to 0 (or below,
  // on an over-close) means the call's OWN paren has closed — the candidate ended the application.
  const closedCall = st.depth <= 0;
  return { positionalCount: st.positionalCount, inProgress, closedCall };
}

/**
 * The KWARGS PROFILE gate — a STRUCTURAL tightening run beside {@link violatesToolCallGrammar}. Returns true
 * iff the candidate continuation `next` VIOLATES the kwargs invocation shape under `profile` (so the
 * candidate must be masked). Called from {@link classifyCandidate} / {@link classifyCandidateSession} ONLY
 * when a profile is present (the no-profile path is byte-unchanged). Keys off the IN-PROGRESS trailing
 * top-level token + the call-close state, so it fires even mid-STRING (where the oracle's `midToken` is
 * false). The shape is `(fn pos1 … pos_requiredCount [:optkey value]…)` — EXACTLY `requiredCount` positionals
 * forced FIRST, then optional kwargs — enforced by two mirror-image regions keyed on `positionalCount`:
 *
 *  BEFORE the budget (`positionalCount < requiredCount`) — the required args are NOT yet all placed, so a
 *  positional VALUE is the only legal continuation; the model must not jump to kwargs or close early:
 *    • an in-progress `:keyword` VIOLATES (no kwarg may open before the required positionals) — this kills
 *      `(travel_itinerary_generator "Tokyo" 7 :exploration_type …)` dropping the 3rd required;
 *    • CLOSING the call (`closedCall`) VIOLATES (a premature `)` would leave required args missing) — this
 *      kills `(calculate_triangle_area 10 :unit …)` / `(predict_house_price 2500 5 1990)` short of arity.
 *    A bare positional value (in-progress `positional`, or descending into a nested `(list …)`) is fine.
 *
 *  AT / PAST the budget (`positionalCount >= requiredCount`) — exactly the required count is placed, so only
 *  `:` (a kwarg) or `)` (done) may follow; a further bare positional is over budget:
 *    (a) an in-progress `positional` VIOLATES iff its index EXCEEDS `requiredCount` — it would place a
 *        positional past the required arity (the optional-positional mis-fill this mode exists to kill);
 *    (b) an in-progress `:keyword` VIOLATES unless the fragment (sans `:`) prefixes some `optionalKeywords`
 *        member — narrows the optional keyword to the schema's set.
 *    A keyword's `value` is always legal (any value); a `none` boundary (whitespace / a closer / a nested-arg
 *    interior) is the structural + EOS gates' business.
 *
 * Net: exactly `requiredCount` top-level positionals are FORCED present, then optional kwargs — HARD across
 * bare atoms / numbers / strings / nested forms (the half-typed positional value is fine; a `:` or a `)`
 * while under budget is masked "structural").
 */
function violatesKwargsProfile(next: string, profile: ToolCallProfile): RuleId | null {
  const st = scanKwargsTopLevel(next);
  const underBudget = st.positionalCount < profile.requiredCount;
  if (st.inProgress === "keyword") {
    // A kwarg may not open until the required positionals are all placed (mirror of the past-budget rule).
    if (underBudget) return "R-KWARGS-ARITY";
    // (b) keyword narrowing — the in-progress keyword (sans ":") must prefix some optional keyword.
    const kw = trailingAtom(next).slice(1); // the `:`-keyword fragment (never inside a string).
    for (const ok of profile.optionalKeywords) if (ok.startsWith(kw)) return null;
    return "R-KWARGS-KEY-NARROW"; // no optional keyword starts with this fragment ⇒ mask it.
  }
  // BEFORE the budget: closing the call would leave required args missing — FORCE the remaining positionals.
  // (`closedCall` only fires for the call's OWN paren returning to depth 0; a nested-form `)` does not.)
  if (underBudget) return st.closedCall ? "R-KWARGS-ARITY" : null;
  // (a) an in-progress POSITIONAL past the required arity is illegal (only `:`/`)` may follow the positionals).
  if (st.inProgress === "positional") return st.positionalCount > profile.requiredCount ? "R-KWARGS-ARITY" : null;
  // A keyword's value, or a boundary/closer (`none`) ⇒ not a kwargs violation.
  return null;
}

// ── POSITIONAL-KEYED profile (every arg a `:keyword value` pair; required keywords forced in order) ──────

/** The positional-keyed top-level state at the END of `next`: the ORDERED sequence of COMPLETED top-level
 *  keyword NAMES (`:`-stripped — e.g. `["location", "date"]`), the class of the in-progress trailing depth-1
 *  token, and whether the call's own paren has closed. Produced by {@link scanPositionalKeyedTopLevel};
 *  consumed by {@link violatesPositionalKeyedProfile}. */
export interface PositionalKeyedTopLevel {
  /** The names of the top-level keywords whose token has CLOSED, in the order they appeared (no leading
   *  `:`). The in-progress trailing keyword (if any) is NOT here — it is reported via `inProgress`/the
   *  trailing atom instead. */
  readonly keywords: readonly string[];
  /** The class of the in-progress trailing depth-1 token (persisting while the cursor descends into a nested
   *  form that opened as a depth-1 token). `"positional"` is the ILLEGAL case here (no bare positional may
   *  follow the operator); `"keyword"` is an in-progress `:`-keyword; `"value"` is a keyword's value;
   *  `"none"` is a boundary (after whitespace / a closer). */
  readonly inProgress: "none" | "positional" | "value" | "keyword";
  /** The class of the last COMPLETED depth-1 argument token — `"keyword"` ⇒ the cursor (at a `"none"`
   *  boundary) is in that keyword's VALUE slot (a keyword must be followed by a value, so the next token is
   *  NOT a keyword); `"value"`/`""` ⇒ the next top-level token is a fresh keyword. Lets the force-emit tell a
   *  keyword-opening boundary from a value-expecting one. */
  readonly prevArgKind: "" | "positional" | "keyword" | "value";
  /** True iff the OPERATOR (the first depth-1 token — the function symbol) has been STARTED. False only when
   *  the cursor is still at the bare-`(` operator slot, before any function name. The operator must be a bare
   *  Σ symbol, never a `:keyword`, so this discriminates the operator slot (where a keyword is ILLEGAL and
   *  must not be forced) from the first argument slot (where the first required keyword is forced). Without it,
   *  the post-`(` boundary and the first keyword boundary are indistinguishable — the bug that forced
   *  `(:requiredKeywords[0]` as the operator. */
  readonly seenOperator: boolean;
  /** The FIRST character of the operator token (`""` until the operator opens). A leading `:` marks a
   *  MALFORMED keyword-shaped operator (`(:distance …` — a `:keyword` consumed at the operator slot); the gate
   *  masks any program whose operator is `:`-led so the operator stays a bare Σ symbol. Scanning `next` alone
   *  cannot otherwise tell `(:` apart from a legal operator, because the first depth-1 token is classified as
   *  the operator regardless of its lead char — this carries the lead char out so the gate can reject it. */
  readonly operatorFirstChar: string;
  /** True iff the candidate CLOSED the call's own paren (the outer application returned to depth 0). A
   *  nested-form `)` (back to depth 1) does NOT set this. */
  readonly closedCall: boolean;
}

/** The mutable scan state of {@link scanPositionalKeyedTopLevel}. Mirrors {@link KwargsScan} but accumulates
 *  the keyword NAME SEQUENCE (not a positional count) — the i-th completed keyword must match the i-th forced
 *  required keyword. `curName` collects the chars of the open depth-1 token so a completed keyword's name is
 *  recorded on close. */
interface PositionalKeyedScan {
  depth: number;
  inStr: boolean;
  seenOperator: boolean;
  inToken: boolean;
  curKind: TokenKind;
  curName: string; // chars accumulated for the CURRENT open depth-1 token (its name, for a keyword).
  prevArgKind: "" | "positional" | "keyword" | "value";
  keywords: string[]; // names of COMPLETED top-level keywords, in order (no leading ":").
  operatorFirstChar: string; // the FIRST char of the operator token ("" until the operator opens) — `:`
  // here means a malformed keyword-shaped operator (`(:distance …`), which the gate masks.
}

/** Open a depth-1 token under the positional-keyed scan, classifying it exactly like the kwargs scan (first
 *  = operator; `:`-prefixed = keyword; the token after a keyword = its value; else a positional). Seeds
 *  `curName` with the first char so a keyword's full name accumulates as the scan walks its interior chars. */
function openPositionalKeyedToken(st: PositionalKeyedScan, firstChar: string): void {
  st.inToken = true;
  st.curName = firstChar;
  if (!st.seenOperator) {
    st.seenOperator = true;
    st.operatorFirstChar = firstChar; // record the operator's lead char — a `:` here is a malformed operator.
    st.curKind = "operator";
  } else if (st.prevArgKind === "keyword") {
    // The token immediately after a keyword is ALWAYS its VALUE — even one that starts with `:` (a keyword
    // must be followed by a value, never another keyword). Checking this BEFORE the `:`-keyword branch closes
    // the `:location :date`-skips-location's-value gap: a second `:` here is location's (odd) value, not date.
    st.curKind = "value";
  } else if (firstChar === ":") {
    st.curKind = "keyword";
  } else {
    st.curKind = "positional";
  }
}

/** Close the current depth-1 token; if it was a keyword, record its `:`-stripped name in `keywords`. */
function closePositionalKeyedToken(st: PositionalKeyedScan): void {
  if (st.curKind === "keyword") st.keywords.push(st.curName.slice(1));
  if (st.curKind === "positional" || st.curKind === "keyword" || st.curKind === "value") st.prevArgKind = st.curKind;
  st.inToken = false;
  st.curKind = "";
  st.curName = "";
}

/** Step the positional-keyed scan over one non-string char. Same depth/open/close machinery as
 *  {@link stepKwargsChar}, but also appends interior chars to `curName` (so a keyword's name is captured) and
 *  routes open/close through the keyword-recording helpers. Returns true iff this char OPENS a string. */
function stepPositionalKeyedChar(st: PositionalKeyedScan, ch: string): boolean {
  const atArgLevel = st.depth === 1 && !st.inToken;
  switch (ch) {
    case '"':
      if (atArgLevel) openPositionalKeyedToken(st, '"');
      else if (st.inToken && st.depth === 1) st.curName += ch;
      return true; // opens a string — interior skipped via inStr by the caller.
    case "(":
    case "[":
    case "{":
      if (atArgLevel) openPositionalKeyedToken(st, "(");
      st.depth++;
      return false;
    case ")":
    case "]":
    case "}":
      if ((st.depth === 2 || st.depth === 1) && st.inToken) closePositionalKeyedToken(st);
      st.depth--;
      return false;
    default:
      if (/\s/.test(ch)) {
        if (st.depth === 1 && st.inToken) closePositionalKeyedToken(st);
      } else if (atArgLevel) {
        openPositionalKeyedToken(st, ch);
      } else if (st.inToken && st.depth === 1) {
        st.curName += ch; // accumulate the open depth-1 token's name chars.
      }
      return false;
  }
}

/**
 * Scan the OUTERMOST application of `next` and classify the positional-keyed top-level token sequence —
 * STRUCTURALLY (oracle-independent, fires mid-string). Walks depth-aware + string-aware from the first `(`,
 * skips the operator, then for each subsequent depth-1 token records keyword names (in order) and tracks the
 * in-progress trailing token. The trailing token may be in progress (incl. an unterminated string). Returns
 * the state AT THE END of `next`.
 */
export function scanPositionalKeyedTopLevel(next: string): PositionalKeyedTopLevel {
  const open = next.indexOf("(");
  if (open === -1)
    return {
      keywords: [],
      inProgress: "none",
      prevArgKind: "",
      seenOperator: false,
      operatorFirstChar: "",
      closedCall: false,
    };
  const st: PositionalKeyedScan = {
    depth: 0,
    inStr: false,
    seenOperator: false,
    inToken: false,
    curKind: "",
    curName: "",
    prevArgKind: "",
    keywords: [],
    operatorFirstChar: "",
  };
  for (let i = open; i < next.length; i++) {
    const ch = next[i];
    if (st.inStr) {
      if (ch === "\\") i++;
      else if (ch === '"') st.inStr = false;
      else if (st.inToken && st.depth === 1) st.curName += ch; // string interior is part of the depth-1 token.
      continue;
    }
    if (stepPositionalKeyedChar(st, ch)) st.inStr = true;
  }
  const inProgress: "none" | "positional" | "value" | "keyword" =
    st.inToken && (st.curKind === "positional" || st.curKind === "value" || st.curKind === "keyword")
      ? st.curKind
      : "none";
  return {
    keywords: st.keywords,
    inProgress,
    prevArgKind: st.prevArgKind,
    seenOperator: st.seenOperator,
    operatorFirstChar: st.operatorFirstChar,
    closedCall: st.depth <= 0,
  };
}

/**
 * The POSITIONAL-KEYED PROFILE gate — the variant of {@link violatesKwargsProfile} for the shape
 *   (fn  :req1 v1  :req2 v2  … :req_n vn   [:optkey value]…)
 * where EVERY argument is a `:keyword value` pair, the required keywords (`profile.requiredKeywords`) FORCED
 * in declaration order. Returns true iff `next` VIOLATES this shape (so the candidate must be masked). Called
 * ONLY when `requiredKeywords` is present (which also means the kwargs `violatesKwargsProfile` path is NOT
 * run for this profile). The rules, all at a TOP-LEVEL argument slot:
 *
 *   • A bare POSITIONAL is ALWAYS illegal — after the operator only `:keyword value` pairs may appear. (An
 *     in-progress `positional`, or descending into a nested form that opened as a positional, VIOLATES.)
 *   • KEYWORD ORDER — let `k = keywords.length` be how many top-level keywords have CLOSED. The (k+1)-th
 *     keyword (the in-progress one) must be the (k+1)-th forced keyword while `k < requiredKeywords.length`
 *     (its `:`-stripped fragment must PREFIX `requiredKeywords[k]`), and once all required keywords are
 *     placed it must prefix some `optionalKeywords` member. A keyword that prefixes neither VIOLATES.
 *   • CLOSE only when COMPLETE — closing the call (`closedCall`) while fewer than every required keyword has
 *     been placed VIOLATES (the required `:keyword value` pairs are forced present). A nested-form `)` does
 *     not set `closedCall`, so it never trips this.
 *
 * A keyword's VALUE (in-progress `value`) and a `none` boundary are legal (the structural + Σ + EOS gates own
 * them). Net: exactly the required keywords, in order, each with a value, then optional keywords — HARD.
 */
function violatesPositionalKeyedProfile(
  next: string,
  required: readonly string[],
  optional: readonly string[],
): RuleId | null {
  const st = scanPositionalKeyedTopLevel(next);
  // THE OPERATOR must be a BARE Σ symbol, never a `:keyword`. A `:`-led operator (`(:distance …`) is masked
  // so the model is steered to emit the function name first — Σ then narrows it to a bound symbol. This is
  // keyed off `operatorFirstChar`, NOT `inProgress`, because by the time we scan `next = "(:"` the `:` has
  // ALREADY been consumed as the operator token (the first depth-1 token is the operator regardless of its
  // lead char), so `inProgress` reads "none" — only the recorded operator lead char reveals the malformed
  // shape. Without this the gate admitted `(:distance …)`, the loud half of the live bug.
  if (st.operatorFirstChar === ":") return "R-POSKEYED-ORDER";
  // A bare positional (anywhere after the operator) is never legal in the positional-keyed shape.
  if (st.inProgress === "positional") return "R-POSKEYED-ORDER";
  const placed = st.keywords.length; // completed top-level keywords so far.
  // Any ALREADY-COMPLETED keyword that is out of order is a violation the moment it closed — but the gate is
  // called per candidate continuation, so we only ever need to validate the keyword the candidate is forming
  // or the close. (A completed keyword was admitted by the same rule when IT was in progress, so the prefix
  // history is consistent by construction; we still defensively re-check the in-progress keyword below.)
  if (st.inProgress === "keyword") {
    const kw = trailingAtom(next).slice(1); // the in-progress keyword fragment (sans ":").
    if (placed < required.length) {
      // The (placed+1)-th keyword must be the (placed)-th forced required keyword (0-indexed) — its fragment
      // must be a live prefix of that exact name.
      return required[placed].startsWith(kw) ? null : "R-POSKEYED-ORDER";
    }
    // All required placed → an optional keyword: its fragment must prefix some optional keyword.
    for (const ok of optional) if (ok.startsWith(kw)) return null;
    return "R-POSKEYED-ORDER";
  }
  // Closing the call before every required keyword is placed leaves required args missing — force them.
  if (st.closedCall) return placed < required.length ? "R-POSKEYED-ORDER" : null;
  // A keyword's value or a boundary (`none`) ⇒ not a positional-keyed violation.
  return null;
}

/** Dispatch the per-call profile gate: the POSITIONAL-KEYED shape when `requiredKeywords` is present (every
 *  arg a `:keyword value` pair, required keywords forced in order), else the kwargs shape (required positional
 *  + optional `:keyword`). One seam so the re-scan and session paths stay verdict-identical. */
export function violatesProfile(next: string, profile: ToolCallProfile): RuleId | null {
  return profile.requiredKeywords === undefined
    ? violatesKwargsProfile(next, profile)
    : violatesPositionalKeyedProfile(next, profile.requiredKeywords, profile.optionalKeywords);
}
