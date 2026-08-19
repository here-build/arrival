// scheme-atoms.ts — the pure scheme-atom leaf utilities (pure kernel, primitive 1).
//
// PURE module: no internal imports. Char-level helpers shared by gate layers (profile-gates,
// structural-gates, force-emit, mask-compiler) shares — the trailing/leading atom run, the
// literal-value / live-symbol-prefix predicates, and the small set helper. Browser-safe.

// Atom-terminating characters, matching arrival's lexer EXACTLY (reader/Lexer.ts `boundary`):
//   delimiters `()[]{}`, whitespace, the string quote `"`, the comment intro `;`, and `,` —
//   the reader made comma a lexer-level delimiter (R7RS §7.1.1; the collection literals need
//   `1,` to lex as `1` + `,`), so the sampler's atom model must split there too.
export const ATOM_BREAK = new Set(["(", ")", "[", "]", "{", "}", '"', ";", ","]);

/** The trailing atom fragment of `src` — the run of atom-content chars from the last delimiter /
 *  whitespace to the end. `""` when the cursor is at a token boundary (last char is a break).
 *  Exported so the metrics layer can name the atom a model reached for on a Σ-reject.
 *  UNQUOTE-SPLICING: the reader lexes `,@` as ONE reader-macro token, so the atom after `,@xs`
 *  is `xs`, not `@xs` — with `,` now a break char the raw run would keep the `@`; strip it when
 *  (and only when) it directly follows a `,` (a bare `@foo` symbol stays intact). */
export function trailingAtom(src: string): string {
  let i = src.length;
  while (i > 0) {
    const c = src[i - 1];
    if (ATOM_BREAK.has(c) || /\s/.test(c)) break;
    i--;
  }
  const run = src.slice(i);
  if (run.startsWith("@") && src[i - 1] === ",") return run.slice(1);
  return run;
}

// A `#`-literal or number — a VALUE (`#t`/`#f`/`#\c`/`#(…)`, or a numeric), INCLUDING A PARTIAL number.
// Σ never binds these, so as an ARGUMENT they bypass the bound-symbol gate. But a value is NOT callable —
// at OPERATOR position it must NOT be exempt (`(1 …)` / `(#t …)` are guaranteed apply-errors), so the
// exemption is position-gated below.
//
// The PARTIAL case is load-bearing for constrained DECODE: a tokenizer routinely splits `-11` into `-` +
// `11`, so the lone leading `-` must read as the START of a negative number, not as the (here unbound)
// subtraction identifier — otherwise the gate masks the sign and the model falls back to `11` (the
// UNCONSTRAINED model emits `-11`; we were eating the minus on every negative arg). So accept any PREFIX
// of a number: an optional sign + optional dot + a digit, or a bare sign / sign-dot / dot that a digit
// will complete. Pure identifiers (`->`, `...`) still fail and stay under Σ. Admitting a bare `-`/`+` is
// the conservative SUPERSET: if it never becomes a number, the next token's Σ check rejects the
// continuation — whereas masking it wrongly restricts a real value (the T/structural contract: never a
// wrong restriction).
export function isLiteralValue(frag: string): boolean {
  return (
    /^[+-]?\.?\d/.test(frag) || // sign?/dot? then a digit: 1, -1, .5, -.5, +3, 1.5
    /^[+-]\.?$/.test(frag) || // a bare sign or sign+dot — a signed number in progress: -, +, -., +.
    frag === "." || // a bare dot — the start of .5
    frag.startsWith("#")
  );
}

/** Is the in-progress atom `frag` a live prefix of any symbol in `valid`? (mid-symbol feasibility —
 *  "net" prefixes "network".) An exact match counts. */
export function isLiveSymbolPrefix(frag: string, valid: ReadonlySet<string>): boolean {
  for (const sym of valid) {
    if (sym.startsWith(frag)) return true;
  }
  return false;
}

/** Project a closed-domain VALUE (a raw string-literal enum member, e.g. `"Scenic View"`) into the SCHEME
 *  SYMBOL the model emits for it. A value the model must name as a single atom cannot carry an atom-terminator
 *  (a space, a bracket, a quote), so every maximal run of non-atom-content characters collapses to one `_`,
 *  with leading/trailing `_` trimmed — the value re-spelled as ONE scheme atom (`"Scenic View"` → `Scenic_View`,
 *  `"New York"` → `New_York`). A value already atom-clean (`"Fastest"`, `"six_months"`) is unchanged. This is
 *  the GENERIC inverse of "a multi-word value bound as a scheme symbol": the model lives in the atom alphabet,
 *  so a member's domain must be compared THERE — it does NOT assume any one producer's sanitiser (only that the
 *  produced symbol is the value's atom-space spelling, which any sanitiser must satisfy). */
export function valueAsSchemeAtom(value: string): string {
  // Single linear scan (no regex — avoids the catastrophic-backtracking class): emit atom-content chars
  // verbatim; collapse each maximal run of atom-terminators (whitespace + lexer delimiters) to one `_`,
  // emitting it only BETWEEN atom-content chars so leading/trailing separators are dropped.
  let out = "";
  let pendingBreak = false;
  for (const ch of value) {
    const isBreak = ATOM_BREAK.has(ch) || /\s/.test(ch);
    if (isBreak) {
      if (out !== "") pendingBreak = true; // a separator after content → a single `_` once content resumes
      continue;
    }
    if (pendingBreak) {
      out += "_";
      pendingBreak = false;
    }
    out += ch;
  }
  return out;
}

/** Is the in-progress atom `frag` a live prefix of any closed-domain MEMBER in `members`, comparing in SCHEME
 *  SYMBOL space (each member projected via {@link valueAsSchemeAtom})? The element-enum domain the type lens
 *  stamps holds RAW string-literal values (`"Scenic View"`), but the model emits the value's atom spelling
 *  (`Scenic_View`); a direct `isLiveSymbolPrefix` against the raw values splits a multi-word member at its first
 *  separator. Projecting each member into atom space first reconciles the two — `Scenic_View` (and its prefix
 *  `Scenic`) is a live prefix of `valueAsSchemeAtom("Scenic View") = "Scenic_View"`; a genuine non-member
 *  (`walking`) still matches nothing. An atom-clean member round-trips, so this is byte-identical to
 *  `isLiveSymbolPrefix` whenever no member carries a separator. */
export function isLiveMemberPrefix(frag: string, members: Iterable<string>): boolean {
  for (const m of members) {
    if (valueAsSchemeAtom(m).startsWith(frag)) return true;
  }
  return false;
}

export const ATOM_TERMINATOR = /[\s()[\]{}";',]/;

/** The atom run of `s` starting at index `from` (stops at the first atom-terminator), or "". */
export function leadingAtom(s: string, from: number): string {
  let i = from;
  let head = "";
  while (i < s.length && !ATOM_TERMINATOR.test(s[i])) head += s[i++];
  return head;
}

/** `a \ b` — the elements of `a` not in `b`. Small sets (a slot's Σ), recomputed per candidate; cheap. */
export function setDifference(a: ReadonlySet<string>, b: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const x of a) if (!b.has(x)) out.add(x);
  return out;
}
