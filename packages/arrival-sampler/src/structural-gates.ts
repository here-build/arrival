// structural-gates.ts — the tool-call grammar tightening + the type-derived structure gates (pure kernel, primitive 1).
//
// PURE char/state scans (no oracle re-scan): the tool-call sublanguage grammar veto
// ({@link violatesToolCallGrammar}), the precise type-derived list-structure gate
// ({@link violatesValueStructure} + its reachability arm), and the array-element force-quote gate
// ({@link violatesElementStructure}). Each is a pure function of `(state?, next/candidateStr)` and a
// no-op until the TYPE LAYER stamps its verdict ⇒ grammar mode is byte-identical. MUST NOT import
// mask-compiler (the composer imports THESE).

import type { OracleState } from "./oracle-types.js";
import type { RuleId } from "./rules.js";
import { ATOM_TERMINATOR, isLiveSymbolPrefix, leadingAtom, setDifference } from "./scheme-atoms.js";

/**
 * The TOOL-CALL GRAMMAR PROFILE — a tightening the sampler enforces on top of the general arrival reader,
 * masking tokens that have no place in a canonical tool call. The general oracle is the full reader; it
 * (correctly) admits these as valid arrival syntax — but in the constrained-decode TOOL-CALL sublanguage
 * we steer the model to one clean shape. THE CONTRACT: Σ admits exactly what the reader reads — VALIDITY,
 * never style (every sampler-forced token off the model's top choice is off-policy contamination that
 * degrades subsequent generation). We mask:
 *  - **quasiquote `` ` ``** — meaningful ONLY as the template opener of a quasiquote, which a tool call
 *    never opens; a mid-form backtick is a markdown-fence leak, handled by the fence/backtick tolerances.
 *    (Unquote `,` is NOT masked anymore: the reader made `,` a lexer-level delimiter and the collection
 *    literals gave it a SEPARATOR role — see the comma rules below.)
 *  - **DEGENERATE quote `'`** — quote at a value slot is now LEGAL (the model natively emits `'(…)` for an
 *    array arg far more often than `(list …)`, so we admit it as a first-class array materializer instead
 *    of forcing `(list …)`). But quote is only ever WELL-FORMED here as `'(`/`'[`/`'{` — a quoted
 *    collection. So we apply a POST-QUOTE FORCING RULE: immediately after a `'`, the only legal next char
 *    is an open bracket. This is a pure function of the prefix (no lookahead): `''` (spam),
 *    `'atom`/`'5`/`'":…"` (quoted scalar/string), `' x` (dangling) are all ungeneratable because the char
 *    after the `'` isn't an opener. A trailing `'` (the quote is the last char emitted so far) is admitted
 *    — the rule forces the opener on the NEXT step.
 *  - **PHANTOM-LIST `'(list …)`** — the bare symbol `list` as the FIRST DATUM of a `'(`-opened quote-list
 *    ({@link quoteListFirstDatumIsBareList}). The model conflates the two array surfaces (`(list …)` the
 *    constructor vs `'(…)` the quote-list) into `'(list "a" "b")`, whose first ELEMENT the scorer then reads
 *    as the literal symbol `list`. The bare constructor `(list …)` (no quote) and `list` as a LATER element
 *    (`'("a" list)`) and longer atoms (`list-ref`/`list->vector`) stay legal — only the exact `list` atom in
 *    the first-datum slot is masked.
 *  - **COLLECTION-LITERAL VALIDITY MIRRORS** — the reader's own rejections on `[a b c]` vector / `{:k v}`
 *    dict literals (spec/corpus/collection-literals-read.jsonl), enforced char-incrementally so an invalid
 *    literal is never generatable: R-BRACKET-MISMATCH (`(a]`), R-DICT-KEY (`{1 2}` — keys are
 *    keyword|string|suffix-flip|unquote-form only; the SUFFIX-KEYWORD FLIP admits a symbol-start at key
 *    position PENDING its single trailing colon — `{flight_number: "X"}` ≡ `{:flight_number "X"}` — and
 *    masks the token that completes key-less, incl. the glued `{a:1}`/`{a:"x"}` teaching-door forms),
 *    R-DICT-ARITY (`{:a}` — a `}` at odd element count), R-DICT-DUP-KEY
 *    (`{:a 1 :a 2}`, `:a`≡`"a"`≡`a:`), R-LITERAL-DOT (`[a . b]`), R-EXPECTING-DATUM (`{:a ,}` — a closer
 *    while an unquote awaits its datum). Maps also mirror the reader's verbatim-JSON colon absorption:
 *    ONE lone `:` atom at an ODD boundary (`{"a": 1}`) is not an element.
 *  - **COMMA** — mirrored to the reader's position-scoped rule: inside a literal, at most ONE comma is a
 *    SEPARATOR per element boundary (vector: after each complete element; dict: at an EVEN boundary only);
 *    everywhere else `,` is an unquote lead and stays ADMISSIBLE wherever a datum may start (the reader
 *    reads it; eval owns the rest). Both spellings of every boundary are admissible — the comma is
 *    OPTIONAL, and masking either spelling would force tail picks.
 * RETIRED: R-NO-BRACKETS (the blanket bare-`[`/`]` ban). The reader now reads `[a b c]` as a vector
 *  literal and `{:k v}` as a dict literal (commit 74ac6ad54a), so the ban had become a STYLE rule — the
 *  exact thing Σ's contract forbids. What it also (incidentally) guarded and is STILL invalid is kept as
 *  precise rules: a stray closer (`]` with no open — the base scanner's overClosed already owns it) and
 *  bracket-kind mismatch (R-BRACKET-MISMATCH above). A bracket INSIDE a string literal is content and
 *  stays legal — every mask here is checked OUTSIDE strings only.
 */
/**
 * The PHANTOM-LIST veto: the bare symbol `list` as the FIRST DATUM of a `'(`-opened quote-list. The model
 * conflates the two array surfaces — `(list "a" "b")` (the constructor: a `(`-call whose operator is `list`)
 * and `'("a" "b")` (the quote-list: literal data) — and emits the chimera `'(list "a" "b")`, a quoted list
 * whose first ELEMENT is the literal symbol `list`. The downstream scorer then reads that bare `list` as
 * element #0 of the array. This is meaningless in the tool-call sublanguage (no array's first element is the
 * word `list`), so we mask the candidate that places it.
 *
 * Pure function of `next` (a left-to-right depth/string-aware scan, NO lookahead beyond `next`). Triggers
 * ONLY when `next` opens (at any depth, outside a string) a `'(` whose FIRST datum is the COMPLETE atom
 * `list`. PRECISION — all of these are admitted (return false):
 *  - `(list …)` — no leading quote, so never a `'(` here (the real constructor stays legal).
 *  - `'("a" list)` — `list` is a LATER element; only the first datum is checked.
 *  - `'(list-ref …)` / `'(lister …)` / `'(list->vector …)` — the first datum atom is `list-ref` etc., which
 *    is NOT the complete atom `list` (the `-`/`e`/`>` are atom chars), so it never matches.
 *  - `'(lis` / `'(l` — an in-progress PREFIX of `list` (or of `list-ref`): the first-datum atom is `lis`,
 *    `≠ "list"`, so a mid-atom prefix that could still extend is never prematurely killed.
 *  - `'(open …)` / `'("foo" …)` / `'(1 2)` — a normal first datum.
 *
 * MID-ATOM vs COMPLETE-ATOM. The candidate boundary is the END of `next` (the decoder just appended the
 * candidate token). So the trailing content of `next` IS at a committed token boundary, and the first-datum
 * atom is read maximally up to the first Scheme atom-terminator (whitespace or one of `()[]{}";'`) OR the end
 * of `next`. EXACT-STRING match on that atom does the mid-atom split for free: the candidate `"list"` after
 * `'(` yields the atom `"list"` (vetoed); the candidate `"list-ref"` yields `"list-ref"` (admitted); the
 * candidate `"lis"` yields `"lis"` (admitted, still extendable). No terminator-presence test is needed — a
 * complete `list` token and a `list`-prefix-of-a-longer-token are simply different trailing atoms.
 */
function quoteListFirstDatumIsBareList(next: string): boolean {
  let inStr = false;
  for (let i = 0; i < next.length; i++) {
    const c = next[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    // A `'(` opens a quote-list. Its first datum begins at the first non-whitespace char after the `(`.
    if (c === "'" && next[i + 1] === "(") {
      let j = i + 2;
      while (j < next.length && /\s/.test(next[j])) j++; // skip interior whitespace to the first datum.
      // Read the first datum's atom run (stops at a terminator or end-of-`next`). A datum that OPENS with a
      // delimiter (`(`/`[`/`"`/a nested `'`/`)`) is not the bare symbol `list` — the run is empty, no match.
      let k = j;
      while (k < next.length && !ATOM_TERMINATOR.test(next[k])) k++;
      if (next.slice(j, k) === "list") return true; // the complete bare `list` atom in the first-datum slot.
      // Not `list` (empty, a prefix, a longer atom, or a delimiter opener) ⇒ keep scanning for a later `'(`.
    }
  }
  return false;
}

/** The kind of an open bracket frame in the grammar scan. `app` = a non-quoted `(…)` application (has an
 *  OPERATOR head slot); `vector`/`dict` = the `[…]`/`{…}` collection literals (EVERY position is a value
 *  position — no operator veto, comma-separator + key/arity rules apply); `data` = quoted forms and the
 *  R7RS `#(…)` constant (pure data — no operator position, no literal rules). */
type GateFrameKind = "app" | "vector" | "dict" | "data";

interface GateFrame {
  kind: GateFrameKind;
  open: "(" | "[" | "{";
  /** The interior is quoted DATA (opened under `'`, or inside a data ancestor) — inherited downward, so
   *  `'(((a)))` never operator-vetoes. `vector`/`dict` frames keep their kind (key/comma rules are READ-time
   *  and apply under quote too — `'{1 2}` is the same E-DICT-BAD-KEY the reader throws) but inherit `data`
   *  so nested `(`-frames under them stop operator-vetoing when the collection itself is quoted. */
  data: boolean;
  /** COMPLETED datums in this frame (an in-progress atom/string/child is not yet counted). */
  elems: number;
  /** A SEPARATOR comma has been consumed at the current element boundary (reset when the next datum opens)
   *  — the reader absorbs at most ONE comma per boundary; a second reads as unquote. */
  sepConsumed: boolean;
  /** Dict only: ONE lone `:` atom has been absorbed at the current ODD boundary — the reader's
   *  verbatim-JSON string-key colon (`{"a": 1}`). Reset when an element completes. */
  colonConsumed: boolean;
  /** Dict only: the completed LITERAL key texts (`:a`, `"a"` and the suffix-flipped `a:` all normalize
   *  to `a`) for the dup-key mirror. Unquote-form keys are dynamic and not tracked. */
  keys: Set<string> | null;
}

/** The unified grammar-scan verdict: the first decisive rule (null = admitted) plus whether the cursor
 *  ends inside a `[…]`/`{…}` COLLECTION LITERAL — the Σ layer reads this to know the "operator" position
 *  the base scanner reports there is really an ELEMENT (value) position. */
export interface GrammarScan {
  readonly rule: RuleId | null;
  readonly literalFrame: boolean;
  /** The cursor's trailing IN-PROGRESS atom sits at a dict KEY position (a key DECLARATION —
   *  `:key` or the suffix-flip `key:` — never a reference): the Σ bound-symbol layer must
   *  degrade there (admit pending the trailing colon; the structural mirror owns completion). */
  readonly keyAtom: boolean;
}

/**
 * THE unified tool-call grammar scan — one string/comment-aware, frame-tracking pass over `next` enforcing
 * every rule in the profile docstring above: quasiquote veto, post-quote forcing, R-HEAD-IS-SYMBOL, the
 * collection-literal validity mirrors (bracket pairing, dict keys/arity/dup-keys, literal dot,
 * expecting-datum), the position-scoped comma roles, and the phantom-list veto. Pure in `next`, no
 * lookahead beyond the committed chars (the same style as the old flat scan — `next[i+1]` peeks only at
 * text the candidate itself carries; a trailing prefix char is admitted and re-judged when the successor
 * lands, so nothing is ever prematurely killed).
 *
 * INCREMENTAL COMPLETENESS INVARIANT: checks that need a COMPLETE token (dup-key, literal-dot) fire only
 * once a terminator lands inside `next` — an in-progress trailing atom is never judged (no over-mask); the
 * step that completes it is the step that gets masked. Checks decidable from the FIRST char (a dict key's
 * opener, a mismatched closer, a head-slot opener) fire immediately.
 *
 * R-HEAD-IS-SYMBOL — every non-quoted APPLICATION must begin with a NAMED SYMBOL: a `(`/`[`/`{`/`#(`
 * opening at the head slot (`app` frame, `elems === 0`, not data) is a sub-application head
 * (`((calc 5 2 4))`, the parallel-collapse `((call)(call))`) and is masked. LITERAL frames NEVER
 * operator-veto their children — `[(f x)]` and `{:a (f x)}` are first-class (all element positions are
 * value positions); an `app` frame nested INSIDE a literal re-applies the veto to its own head.
 */
export function scanToolCallGrammar(next: string): GrammarScan {
  const stack: GateFrame[] = [];
  let inStr = false;
  let strText = ""; // captured content of the in-progress string (for the dict dup-key mirror)
  let inComment = false; // a `;` line comment — its interior is text, not structure
  let inAtom = false;
  let curAtom = "";
  let curIsKey = false; // the in-progress datum opened at a dict KEY position
  let curUnquoted = false; // the in-progress datum is an unquote form's target (`,x`)
  let pendingQuote = false; // a `'` was seen — the next opener is quoted data
  let pendingUnquote = false; // a `,`/`,@` was seen in unquote role — a datum must follow
  let opened = false; // a top-level form has opened (the post-form fence semantics)
  let verdict: RuleId | null = null;

  const top = (): GateFrame | undefined => stack[stack.length - 1];
  const isLiteral = (f: GateFrame | undefined): boolean => f !== undefined && (f.kind === "vector" || f.kind === "dict");
  const fail = (r: RuleId): GrammarScan => ({ rule: r, literalFrame: false, keyAtom: false });

  /** A datum OPENS at the current boundary (`opener` = its first char). Dict-KEY validity (immediate,
   *  first-char-decidable: a COMPOUND opener `(`/`[`/`{` can NEVER become a key; an ATOM opener is
   *  admissible PENDING the suffix-keyword flip's trailing colon — `flight_number:` — and is judged at
   *  completion by finishAtom) + the boundary bookkeeping (separator budget resets, the pending unquote
   *  is consumed). The `'` and `#(` key vetoes live at their own branches. */
  const startDatum = (opener: string): RuleId | null => {
    const f = top();
    curIsKey = f !== undefined && f.kind === "dict" && f.elems % 2 === 0;
    curUnquoted = pendingUnquote;
    pendingUnquote = false;
    if (f) f.sepConsumed = false; // past the boundary — the next boundary gets its own separator budget
    if (curIsKey && !curUnquoted && (opener === "(" || opener === "[" || opener === "{")) return "R-DICT-KEY";
    return null;
  };

  /** The in-progress ATOM completes (a terminator landed). The complete-token mirrors: literal-dot,
   *  the JSON string-key colon absorption, dict KEY validity at completion (prefix `:key` or the
   *  suffix-keyword flip `key:` — a bare/glued atom completing key-less is the reader's E-DICT-BAD-KEY),
   *  and dict dup-key (`:a`, `"a"` and `a:` all normalize to `a`, matching the reader's fold). */
  const finishAtom = (): RuleId | null => {
    if (!inAtom) return null;
    inAtom = false;
    const atom = curAtom;
    curAtom = "";
    const f = top();
    if (!f) return null;
    if (isLiteral(f) && atom === ".") return "R-LITERAL-DOT"; // a dotted pair is meaningless in a literal
    if (f.kind === "dict" && !curIsKey && !curUnquoted && atom === ":" && !f.colonConsumed) {
      // Verbatim-JSON string-key colon: the reader absorbs ONE lone `:` at an ODD boundary
      // (`{"a": 1}`) — not an element. Mirror the absorption (elems unchanged).
      f.colonConsumed = true;
      return null;
    }
    if (f.kind === "dict" && curIsKey && !curUnquoted) {
      let key: string | null = null;
      if (atom.startsWith(":") && atom.length > 1) key = atom.slice(1); // prefix keyword `:a`
      else if (!atom.startsWith(":") && atom.length >= 2 && atom.endsWith(":") && !atom.endsWith("::"))
        key = atom.slice(0, -1); // the suffix-keyword flip `a:` (single trailing colon)
      if (key === null) return "R-DICT-KEY"; // completed key-less — bare symbol / number / lone `:` / `a::`
      if (f.keys!.has(key)) return "R-DICT-DUP-KEY";
      f.keys!.add(key);
    }
    f.elems++;
    f.colonConsumed = false;
    return null;
  };

  /** The in-progress STRING completes (the closing `"` landed) — the string-key dup mirror + the count. */
  const finishString = (): RuleId | null => {
    const f = top();
    if (!f) return null;
    if (f.kind === "dict" && curIsKey && !curUnquoted) {
      if (f.keys!.has(strText)) return "R-DICT-DUP-KEY";
      f.keys!.add(strText);
    }
    f.elems++;
    f.colonConsumed = false;
    return null;
  };

  for (let i = 0; i < next.length; i++) {
    const c = next[i];
    if (inStr) {
      if (c === "\\") {
        const esc = next[i + 1];
        if (esc !== undefined) strText += esc; // raw-text capture: `\"`→`"`, `\\`→`\` (dup keys compare raw)
        i++;
      } else if (c === '"') {
        inStr = false;
        verdict = finishString();
        if (verdict) return fail(verdict);
        strText = "";
      } else strText += c;
      continue;
    }
    if (inComment) {
      if (c === "\n") inComment = false;
      continue;
    }

    // POST-FORM: the top-level form has opened AND closed — the model is PAST the call. A trailing
    // `` ` ``/`,` is it closing its ```scheme code FENCE (end-of-code), NOT scheme syntax; extraction trims
    // it. A subsequent `(` (a parallel call) re-opens the stack and is validated normally.
    const postForm = opened && stack.length === 0;

    if (c === '"') {
      // GLUED-KEY mirror: the reader's lexer does NOT delimit on `"` — a `"` straight after an
      // in-progress KEY atom glues into ONE symbol token (`{a:"x"}` → the symbol `a:"x"`, the
      // E-DICT-BAD-KEY teaching door; JSON emitters space after the colon). Mask the glue.
      if (inAtom && curIsKey && !curUnquoted && top()?.kind === "dict") return fail("R-DICT-KEY");
      verdict = finishAtom();
      if (verdict) return fail(verdict);
      verdict = startDatum('"');
      if (verdict) return fail(verdict);
      inStr = true;
      strText = "";
      continue;
    }
    if (c === ";") {
      verdict = finishAtom();
      if (verdict) return fail(verdict);
      inComment = true;
      continue;
    }
    if (/\s/.test(c)) {
      verdict = finishAtom();
      if (verdict) return fail(verdict);
      continue;
    }
    if (c === "`") {
      verdict = finishAtom();
      if (verdict) return fail(verdict);
      // quasiquote — a tool call never opens a template; admitted post-form as the fence-close signal.
      if (!postForm) return fail("R-UNQUOTE-QUASI");
      continue;
    }
    if (c === ",") {
      verdict = finishAtom();
      if (verdict) return fail(verdict);
      if (postForm) continue; // fence tail — admitted, carries no role
      const f = top();
      // `,@` is ALWAYS unquote-splicing, never a separator (the reader lexes it as one token).
      const splicing = next[i + 1] === "@";
      // SEPARATOR role — the reader absorbs at most ONE comma per element boundary: vector after any
      // complete element; dict at an EVEN boundary only (after a complete key-value pair). Everywhere
      // else (odd dict boundary, second comma, leading comma, app frames, top) the comma is an UNQUOTE
      // lead — admissible wherever a datum may start (the reader reads it; eval owns the rest).
      const sepOK =
        isLiteral(f) &&
        !f!.sepConsumed &&
        f!.elems > 0 &&
        (f!.kind === "vector" || f!.elems % 2 === 0) &&
        !pendingUnquote;
      if (sepOK && !splicing) {
        f!.sepConsumed = true;
      } else {
        pendingUnquote = true;
        if (splicing) i++; // consume the `@` — the next datum is the splicing target
      }
      continue;
    }
    if (c === "'") {
      verdict = finishAtom();
      if (verdict) return fail(verdict);
      // POST-QUOTE FORCING: the char immediately after `'` must open a collection (`(`/`[`/`{`). A
      // trailing `'` (last char so far) is admitted — the next step forces the opener.
      const nxt = next[i + 1];
      if (nxt !== undefined && nxt !== "(" && nxt !== "[" && nxt !== "{") return fail("R-POST-QUOTE-PAREN");
      // A quote-form can never be a dict KEY (keys: keyword|string|unquote-form) — masked at the `'`
      // itself, unless a pending unquote owns the datum (`,'k` — the unquote form is the key).
      const f = top();
      if (f?.kind === "dict" && f.elems % 2 === 0 && !pendingUnquote) return fail("R-DICT-KEY");
      pendingQuote = true;
      continue;
    }
    if (c === "#" && !inAtom && next[i + 1] === "(") {
      // R7RS `#(…)` vector CONSTANT — one datum, its interior pure data.
      verdict = startDatum("#");
      if (verdict) return fail(verdict);
      if (curIsKey && !curUnquoted) return fail("R-DICT-KEY"); // `#(` is a compound — can never become a key
      const f = top();
      if (f && f.kind === "app" && !f.data && f.elems === 0) return fail("R-HEAD-IS-SYMBOL"); // a constant is not a callable head
      stack.push({ kind: "data", open: "(", data: true, elems: 0, sepConsumed: false, colonConsumed: false, keys: null });
      pendingQuote = false;
      opened = true;
      i++; // the `(` is consumed with the `#`
      continue;
    }
    if (c === "(" || c === "[" || c === "{") {
      verdict = finishAtom();
      if (verdict) return fail(verdict);
      const f = top();
      verdict = startDatum(c); // dict-KEY validity: a plain compound opener can never become a key
      if (verdict) return fail(verdict);
      // R-HEAD-IS-SYMBOL: a compound opener at a non-quoted APPLICATION's head slot. Literal frames
      // (vector/dict) and data frames never operator-veto.
      if (f && f.kind === "app" && !f.data && f.elems === 0) return fail("R-HEAD-IS-SYMBOL");
      const data = pendingQuote || (f?.data ?? false);
      const kind: GateFrameKind = c === "[" ? "vector" : c === "{" ? "dict" : data ? "data" : "app";
      stack.push({ kind, open: c, data, elems: 0, sepConsumed: false, colonConsumed: false, keys: c === "{" ? new Set() : null });
      pendingQuote = false;
      opened = true;
      continue;
    }
    if (c === ")" || c === "]" || c === "}") {
      verdict = finishAtom();
      if (verdict) return fail(verdict);
      // A closer while an unquote still awaits its datum — the reader's E-EXPECTING-DATUM (`{:a ,}`).
      if (pendingUnquote) return fail("R-EXPECTING-DATUM");
      const f = stack.pop();
      if (f === undefined) continue; // over-close — the base scanner's overClosed owns it (feasible=false)
      const want = f.open === "(" ? ")" : f.open === "[" ? "]" : "}";
      if (c !== want) return fail("R-BRACKET-MISMATCH"); // `(a]` / `[a)` — the reader's E-BRACKET-MISMATCH
      // `}` closing a dict at an odd element count — a key without its value (E-DICT-ODD-ARITY).
      if (f.kind === "dict" && f.elems % 2 === 1) return fail("R-DICT-ARITY");
      const p = top();
      if (p) {
        p.elems++; // the closed frame is one completed datum of its parent
        p.colonConsumed = false;
      }
      continue;
    }
    // Atom content (symbols, numbers, `#…` literals, a splicing target after `,@`).
    if (!inAtom) {
      verdict = startDatum(c); // dict-KEY validity: a key atom must open with `:` (a keyword)
      if (verdict) return fail(verdict);
      inAtom = true;
      curAtom = c;
    } else {
      curAtom += c;
    }
  }

  // The phantom-list veto: `'(list …)` — the bare symbol `list` standing as a quote-list's first datum.
  if (quoteListFirstDatumIsBareList(next)) return fail("R-PHANTOM-LIST");
  return { rule: null, literalFrame: isLiteral(top()), keyAtom: inAtom && curIsKey && !curUnquoted };
}

/** The rule-only view of {@link scanToolCallGrammar} — the historical entry point tests/tools pin. */
export function violatesToolCallGrammar(next: string): RuleId | null {
  return scanToolCallGrammar(next).rule;
}

/**
 * The type-derived LIST-STRUCTURE gate (PRECISE). At a value-slot-START, a LITERAL's structure must match
 * the slot's TS type: an ARRAY slot rejects a scalar literal (→ forces a `(list…)`/`'(…)`/`[…]`
 * materializer, fixing the night's under-listing sink; the `[…]` vector literal is LIVE — the reader
 * parses it since 74ac6ad54a and the grammar layer admits it); a SCALAR slot rejects a list literal (the literal kind of
 * over-listing). A SCALAR slot is one stamped `slotIsArray === false` OR `slotIsStringy === true` (a free-form
 * string/any) — both forbid a `'(…)` list value, the escape hatch the scalar-string Σ exemption removes (with
 * the bare word now admitted, a `'(` quote-list at a string slot is masked so the model has no list fallback).
 * AMBIGUOUS openers are NEVER gated here — `(` (a CALL, whose return type the lens narrows at the callee) and
 * bare symbols (references, incl. a CHAINED call's output) stay legal, so computed and chained args survive
 * (the reason precise beats strict — strict would foreclose `(set-x (find-y …))`).
 *
 * WHITESPACE-LED OPENERS. The model routinely emits the value-opener glued behind a space in ONE token
 * (` '` = space + quote, the live `'(…)` corruption's first token). So the opener char is the first
 * NON-WHITESPACE char of `candidateStr`, not `candidateStr[0]` — otherwise a ` '` candidate slips through
 * (its first char is a space) and the `'(` opens, after which the cursor is inside a `quote` form where the
 * gate no longer applies. An all-whitespace candidate has no opener yet ⇒ not a violation (the next step decides).
 *
 * Pure in `(state, candidateStr)`. Fires only once the type layer has stamped a scalar/array/stringy verdict;
 * the base structural oracle leaves all three unset ⇒ this is a no-op (grammar mode byte-identical). The
 * caller passes the VALUE-SLOT state (the prefix's `analyze`/`session.state`, computed once per step).
 */
export function violatesValueStructure(state: OracleState, candidateStr: string): RuleId | null {
  // ── TYPE-REACHABILITY arm (NEW) — mask a call whose HEAD provably returns an ARRAY at a SCALAR context.
  // Fires off `arrayReturningHeads` (stamped only in a scalar context: a scalar value slot OR a nested
  // operator whose enclosing slot is scalar). UNLIKE the literal arm below it fires at OPERATOR position too
  // (the incremental `(get_route (list` — the head typed after a committed `(`), so its guard is separate.
  // The SOUND polarity is the dual of `ReturnType ⊆ T`: mask iff the head can ONLY become an array-returning
  // op — a bare `(` (empty head, prefixes every op) and `(car`/`(first` (element returns) stay ADMITTED,
  // keeping the sequential-execution pipe; only `(list`/`(vector`/`(append` (the head reaches no scalar) die.
  if (state.arrayReturningHeads !== undefined && violatesReachability(state, candidateStr))
    return "R-REACHABILITY-ARRAY-HEAD";

  // ── LIST-STRUCTURE literal arm (existing) — only at a fresh argument-slot value: a token boundary (not
  // mid-atom) at an application argument. UNCHANGED guard (the reachability arm above has its own).
  if (state.midToken || state.position !== "argument" || state.formKind !== "application") return null;
  const arr = state.slotIsArray;
  // A SCALAR slot: an explicit non-array verdict OR a free-form string/any (slotIsStringy). Both reject a
  // list literal. (A stringy slot is non-array by construction, but slotIsArray may be unset where
  // slotIsStringy is set, so consult both.) An ARRAY slot rejects scalar literals.
  const scalar = arr === false || state.slotIsStringy === true;
  if (arr !== true && !scalar) return null; // no usable verdict ⇒ never restrict (superset-safe)
  // The value-opener = the first NON-WHITESPACE char of the candidate (handles a whitespace-led ` '`).
  let i = 0;
  while (i < candidateStr.length && /\s/.test(candidateStr[i])) i++;
  const c = candidateStr[i];
  if (c === undefined) return null; // all-whitespace (or empty) ⇒ no opener yet, not a violation
  const isListLiteral = c === "[" || c === "'"; // vector / quote-list — the unambiguous list openers
  if (arr === true) return c === '"' || (c >= "0" && c <= "9") || c === "#" ? "R-ARRAY-REJECTS-SCALAR" : null; // ARRAY slot rejects scalar literals
  if (isListLiteral) return "R-SCALAR-REJECTS-LIST"; // SCALAR slot always rejects a list literal
  // STRING-TYPED scalar slot (a free-form string, OR a closed string-literal enum — `slotIsStringTyped`):
  // a NON-STRING scalar literal is type-wrong — a `#`-literal (`#t`/`#f`/`#\c`, the live `route_type → #f`)
  // or a NUMBER reaches no string value. Mask those too (the `"` string opener and bound enum members via Σ
  // stay legal; a number/`#` slot — stringTyped false/unset — keeps them, superset-safe). The literal twin of
  // the reachability arm: a literal whose type can't reach `T` is the same dead end a `(head` whose RETURN
  // can't reach `T` is.
  const isNonStringScalarLiteral = c === "#" || (c >= "0" && c <= "9");
  return state.slotIsStringTyped === true && isNonStringScalarLiteral ? "R-STRINGSLOT-REJECTS-NONSTRING" : null;
}

/**
 * The TYPE-REACHABILITY check (the {@link violatesValueStructure} arm). Returns true iff, at a SCALAR
 * context (`state.arrayReturningHeads` stamped), the candidate opens — or continues — a call whose HEAD can
 * ONLY be an array-returning op (a dead end: its `T[]` result can never fill the scalar slot). Two firing
 * sites by `state.position`:
 *  - ARGUMENT (the GLUED `(get_route (list` — one token closes the head and opens the value): the candidate's
 *    value-opener must be `(`; the head-prefix is the atom run immediately after it (`(list` → `list`,
 *    `(` → "", `( car` → `car`).
 *  - OPERATOR (the INCREMENTAL `(get_route (` committed, then `list` typed): the head-prefix is the trailing
 *    atom of the candidate continuation (the partial head being typed at the nested operator).
 * MASK iff the head-prefix is a live prefix of an array-returning head AND NOT a live prefix of any OTHER
 * (reachable, non-array) bound symbol — i.e. it can ONLY complete to an array op. An EMPTY head-prefix
 * (bare `(`) prefixes every symbol, so it has a non-array completion ⇒ ADMITTED (the pipe's shared prefix).
 * Pure in `(state, candidateStr)`.
 */
function violatesReachability(state: OracleState, candidateStr: string): boolean {
  const arrayHeads = state.arrayReturningHeads;
  if (arrayHeads === undefined || arrayHeads.size === 0) return false;
  let headPrefix: string;
  if (state.position === "argument") {
    // GLUED: the value OPENS this step (a boundary) with a call `(head`. Skip leading whitespace to the
    // value-opener; it must be `(`. The head-prefix is the atom run immediately after it.
    if (state.midToken) return false; // mid-atom in this arg slot — the value already opened, not a fresh call
    let i = 0;
    while (i < candidateStr.length && /\s/.test(candidateStr[i])) i++;
    if (candidateStr[i] !== "(") return false; // not a call opener — the literal arm / Σ own the rest
    i += 1;
    while (i < candidateStr.length && /\s/.test(candidateStr[i])) i++; // `( list` is the same as `(list`
    headPrefix = leadingAtom(candidateStr, i);
  } else if (state.position === "operator") {
    // INCREMENTAL: the candidate forms the nested operator's head — its LEADING atom (after optional leading
    // whitespace). This catches a single-token head (`list`, ` list`, `list)`); a head split CHAR-BY-CHAR
    // across the commit boundary (committed partial `li`, candidate `st`) is admitted until a single
    // candidate carries enough of the head to be provably array (a tolerated superset — the glued/single-token
    // path covers the live `(list …)` corruption, and Σ still bounds the operator).
    let i = 0;
    while (i < candidateStr.length && /\s/.test(candidateStr[i])) i++;
    headPrefix = leadingAtom(candidateStr, i);
  } else {
    return false;
  }
  // The reachable (non-array, admitted) head universe at this slot = the slot's bound symbols minus the
  // provably-array ones. A miss on `validSymbols()` (Σ not modelled) leaves the broad set unknown ⇒ fall back
  // to "is it a live prefix of an array head" alone (still superset-safe: the array heads are a real subset).
  const valid = state.validSymbols();
  const onlyArray =
    isLiveSymbolPrefix(headPrefix, arrayHeads) &&
    (valid === null || !isLiveSymbolPrefix(headPrefix, setDifference(valid, arrayHeads)));
  return onlyArray;
}

/**
 * The ARRAY-ELEMENT force-quote gate (CUT A) — the inner twin of {@link violatesValueStructure} for a value
 * sitting at the START of an element INSIDE an array surface (`(list …)`, `'(…)`). Fires iff the TYPE LAYER
 * stamped the element as a free-form `string`/`any` (`elementIsStringy === true`). Returns true iff the
 * candidate opens the element with a form we mask to FORCE the quoted string:
 *  - a BARE WORD (a symbol/atom start that is not a value-opener delimiter) — masked. A bare multi-word
 *    element (`open hole`) whitespace-splits at the scorer, so the quote must be forced UPFRONT (the space
 *    has already split it by the time a second word lands — there is no fixing it after the first word). This
 *    is the INVERSE of the scalar exemption: at a SCALAR string slot a bare word is ADMITTED (`(fn men)` ≡
 *    `(fn "men")`); at an ARRAY ELEMENT it is MASKED so the value survives the scorer's whitespace split.
 *  - a NESTED list-opener `'` / `[` — masked (the `(list '(…))` / `(list [..])` nested-wrap over-listing).
 * ADMITTED (return false): `"` (the forced quoted-string form — HARMLESS for a single word: `vegan` ≡
 * `"vegan"` via the scorer's symbol→literal lowering, NECESSARY for multi-word), and `(` (a CALL — a
 * computed/chained element survives, mirroring the precise-not-strict rule of the outer structure gate).
 *
 * Surface-AGNOSTIC: it keys off `elementIsStringy` alone (the lens already determined the cursor is an array
 * element of a string type), so it fires identically inside an `application` `(list …)` element and inside a
 * `quote` `'(…)` element — no position/formKind guard (those differ across the two surfaces). Pure in
 * `(state, candidateStr)`. A no-op until `elementIsStringy` is stamped ⇒ grammar mode byte-identical.
 */
export function violatesElementStructure(state: OracleState, candidateStr: string): RuleId | null {
  // Only at a value-START (a token boundary, not mid-atom) where the element type is a free-form string/any.
  if (state.midToken || state.elementIsStringy !== true) return null;
  // The value-opener = the first NON-WHITESPACE char of the candidate (handles a whitespace-led ` x` / ` '`).
  let i = 0;
  while (i < candidateStr.length && /\s/.test(candidateStr[i])) i++;
  const c = candidateStr[i];
  if (c === undefined) return null; // all-whitespace (or empty) ⇒ no opener yet, not a violation
  // ADMIT the forced quoted-string form and a computed/chained CALL. Numbers/#-literals are type-wrong at a
  // string element but out of scope here (Σ/type own them) — left admitted, conservative.
  if (c === '"' || c === "(" || (c >= "0" && c <= "9") || c === "#") return null;
  // ADMIT a CLOSER (`)` `]` `}`) — the array may legally be EMPTY or the model may end it after prior
  // elements; force-quote must never force a spurious element. Whitespace already skipped above.
  if (c === ")" || c === "]" || c === "}") return null;
  // MASK everything else that OPENS the element: a nested list-opener (`'` / `[`, the over-listing
  // nested-wrap) and any BARE-WORD / symbol start (a letter, a kebab/operator char) — forcing the quote
  // upfront. The model's next live choice at this position is `"` (the quoted string), which is reachable.
  return "R-ELEM-FORCE-QUOTE";
}
