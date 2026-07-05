// scope-scan — the LOCAL-BINDING scanner for the SCOPE-CONFUSION door
// (docs/working-proposals/manifold-scope-confusion-door.md, doors.ts's `scopeConfusionDoor`,
// session-history.ts's `LocalBindingTracker`). Finds every identifier bound in a NON-top-level
// lexical scope inside a submitted program's source: a let/let*/letrec/letrec* binding (incl. a
// named-let's own loop name), a lambda parameter (incl. the single-symbol variadic form), or a
// nested `(define X ...)` — one whose enclosing depth is greater than the program's own
// top-level form. A top-level `(define X ...)` is NOT a local binding (that's the OTHER
// tracker, session-history.ts's `SessionHistory`, keyed on real evaluation success).
//
// v1 TOKENIZER WALK, not a full reader/AST (the spec explicitly allows a "source-regex fallback
// … acceptable for v1" — this is a lighter-weight structural step up from that: it reuses the
// SAME tokenizer manifold-tool.ts's own `splitTopLevel` already runs, walking depth the same way,
// rather than a blind regex over raw text). OVER-COLLECTION is the safe direction (same
// precedent as session-history.ts's `TOOL_SYMBOL`): a name flagged "local" that turns out to be
// something else with the same spelling costs nothing (the door's classifier only ever reads
// this as "have I seen X locally before", never as a hard guarantee) — under-collection would
// silently drop a real teaching opportunity instead.

import { tokenize } from "@here.build/arrival";

interface Tok {
  token: string;
  offset: number;
}

// Same opener/closer/skip conventions as manifold-tool.ts's `splitTopLevel` (isOpen/CLOSE/
// isSkippable) — kept as independent, small, private copies rather than shared exports: this
// module has no other reason to depend on manifold-tool.ts, and the rules are stable lexer
// facts (a vector/bytevector opener is a single hash-prefixed token; `#\(` is a char literal
// leaf, not an opener), not something the two files need to renegotiate together.
const isOpenTok = (tok: string): boolean =>
  tok === "(" || tok === "[" || tok === "{" || (tok.startsWith("#") && !tok.startsWith("#\\") && tok.endsWith("("));
const CLOSE = new Set([")", "]", "}"]);
const isSkip = (tok: string): boolean =>
  /^\s+$/.test(tok) || tok.startsWith(";") || tok.startsWith("#|") || tok.startsWith("#;");

const LET_FORMS = new Set(["let", "let*", "letrec", "letrec*"]);

/** From index `at` (expected to be either the opening paren of a lambda's parameter list, or a
 *  bare symbol for a variadic `(lambda args body...)`), collect every top-level symbol of that
 *  list into `names` — this dialect's lambda params are a flat list, never destructured, so one
 *  pass suffices. */
function collectParamList(tokens: readonly Tok[], at: number, names: Set<string>): void {
  const opener = tokens[at];
  if (!opener) return;
  if (!isOpenTok(opener.token)) {
    names.add(opener.token); // variadic: the single bound name
    return;
  }
  let depth = 1;
  for (let i = at + 1; i < tokens.length && depth > 0; i++) {
    const t = tokens[i]!.token;
    if (isOpenTok(t)) depth++;
    else if (CLOSE.has(t)) depth--;
    else if (depth === 1) names.add(t);
  }
}

/** From index `at` (expected to be the opening paren of a let-family's WHOLE bindings list),
 *  collect the first symbol of each `(name val...)` pair into `names`. */
function collectBindingPairs(tokens: readonly Tok[], at: number, names: Set<string>): void {
  const opener = tokens[at];
  if (!opener || !isOpenTok(opener.token)) return;
  let i = at + 1;
  let depth = 1;
  while (i < tokens.length && depth > 0) {
    const t = tokens[i]!.token;
    if (CLOSE.has(t)) {
      depth--;
      i++;
      continue;
    }
    if (isOpenTok(t)) {
      const nameTok = tokens[i + 1];
      if (nameTok && !isOpenTok(nameTok.token) && !CLOSE.has(nameTok.token)) names.add(nameTok.token);
      let pairDepth = 1;
      i++;
      while (i < tokens.length && pairDepth > 0) {
        const pt = tokens[i]!.token;
        if (isOpenTok(pt)) pairDepth++;
        else if (CLOSE.has(pt)) pairDepth--;
        i++;
      }
      continue;
    }
    i++;
  }
}

/** Scans `source` for every identifier bound in a NON-top-level lexical scope: a let, let*,
 *  letrec, or letrec* binding (including a named-let's own loop name), a lambda parameter, or a
 *  nested `(define X ...)`. Returns a de-duplicated list, order unspecified — the caller
 *  (manifold-tool.ts, feeding session-history.ts's `LocalBindingTracker`) only ever needs
 *  set membership. */
export function scanLocalBindings(source: string): string[] {
  const tokens = (tokenize(source, true) as Tok[]).filter((t) => !isSkip(t.token));
  const names = new Set<string>();
  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!.token;
    if (isOpenTok(tok)) {
      depth++;
      const head = tokens[i + 1]?.token;
      if (head === "lambda") {
        collectParamList(tokens, i + 2, names);
      } else if (head !== undefined && LET_FORMS.has(head)) {
        let j = i + 2;
        // Named let: `(let loop ((x 5)) ...)` — `loop` is itself a local (recursive) binding.
        const maybeName = tokens[j];
        if (maybeName && !isOpenTok(maybeName.token)) {
          names.add(maybeName.token);
          j++;
        }
        collectBindingPairs(tokens, j, names);
      } else if (head === "define" && depth > 1) {
        const nameTok = tokens[i + 2];
        if (nameTok) {
          if (isOpenTok(nameTok.token)) {
            const fnName = tokens[i + 3];
            if (fnName) names.add(fnName.token);
          } else {
            names.add(nameTok.token);
          }
        }
      }
    } else if (CLOSE.has(tok)) {
      depth = Math.max(0, depth - 1);
    }
  }
  return [...names];
}
