// ----------------------------------------------------------------------
// The syntax-rules macro engine — facade over the pattern matcher (extract_patterns,
// syntax-rules/match.ts), the template transcriber (transform_syntax,
// syntax-rules/transcribe.ts), and data-position un-renaming (restore_data_gensyms, here).
// Consumed by the syntax-rules builtin (env/macros/macros.ts).
//
// EVALUATE-FREE: rewrites code, never runs it.
//
// NO MODULE-LEVEL ENV: hygiene identity flows in through the injected HygieneScope
// (useResolver, captured defResolver, capabilities.globalRoot as unshadowed-base
// identity) and the per-run ctx — the syntax-rules caller threads them.
//
// MINT DOOR / SPAN PROPAGATION: see syntax-rules/mint.ts.
//
// Attribution: derived from LIPS Scheme (Jakub T. Jankiewicz) — see LICENSE.
// Lineage: hygienic macro expansion (Kohlbecker et al. 1986; Clinger & Rees 1991);
// R7RS §4.3.2 syntax-rules; ellipsis sub-patterns per SRFI-46.
// ----------------------------------------------------------------------
import type { RunContext } from "../run/RunContext.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import type { SchemeValue } from "../values/types.js";
import type { GensymRecord } from "./syntax-rules/transcribe.js";
import { carrySpan, consCell, isMinted, type Pair } from "./syntax-rules/mint.js";

// Restore hygiene-renamed gensyms to their literal symbols, but ONLY in DATA positions —
// under quote/quasiquote, EXCLUDING unquote(-splicing) holes (which are code). A template
// identifier under quote is DATA, not a reference, so hygiene must not rename it (standard
// expander behaviour). The renamer over-renames every identifier; this single pass un-renames
// the data positions of the transcribed FORM, so quote yields the literal symbol with no
// post-eval fixup.
//
// Runs on the FORM, not the evaluated result: a result-side fixup would ride the trampoline as
// an onResolve, composing through a tail chain → O(depth) for a deep macro tail loop. Restoring
// the form once per expansion never composes, so a macro in tail position keeps O(1) TCO.
//
// COST: O(cells the mint door built). A pair the door did not mint is a call-site fragment
// (a substituted pattern variable) — it cannot contain THIS expansion's gensyms, so it is
// returned by reference, never walked or copied. The walk iterates each cdr spine (host-stack
// depth = nesting depth, not list length), so a 50k-element argument passes straight through.
//
// A nested `(syntax-rules …)` is OPAQUE: its patterns and templates are code for the INNER
// macro, which renames and un-renames them itself; restoring a quoted inner template here would
// split an inner pattern variable from its occurrence (`'a` ≠ the gensym `a` the pattern bound).
export function restore_data_gensyms(
  node: SchemeValue,
  gensyms: readonly GensymRecord[],
  ctx: RunContext,
): SchemeValue {
  if (gensyms.length === 0) return node;
  const nameOf = (sym: ASymbol) => gensyms.find((g) => g.gensym === sym)?.name;
  const restore = (sym: ASymbol) => {
    const name = nameOf(sym);
    // Interned mint: an already-known literal name is a flyweight HIT (no allocation,
    // no charge); a genuinely fresh name charges 1 inside ASymbol's own ctor.
    return name === undefined ? sym : new ASymbol(name);
  };
  const isNestedRules = (head: unknown) =>
    head instanceof ASymbol && (head.literal() === "syntax-rules" || nameOf(head) === "syntax-rules");

  function walk(n: SchemeValue, data: boolean): SchemeValue {
    if (n instanceof ASymbol) return data ? restore(n) : n;
    if (!isMinted(n)) return n;
    if (isNestedRules(n.car)) return n;
    // Spine walk. Each cell's operand context comes from the cell's own head, exactly as the
    // recursive reading `walk(cdr, childData)` — head resolves in the CURRENT context, the
    // rest of the spine takes childData.
    const cells: Pair[] = [];
    const cars: SchemeValue[] = [];
    let mode = data;
    let cur: SchemeValue = n;
    let changed = false;
    while (isMinted(cur)) {
      const head = cur.car;
      const car = walk(head, mode);
      changed ||= car !== head;
      cells.push(cur);
      cars.push(car);
      if (head instanceof ASymbol) {
        const lit = head.literal();
        if (lit === "quote" || lit === "quasiquote") mode = true;
        else if (lit === "unquote" || lit === "unquote-splicing") mode = false;
      }
      cur = cur.cdr;
    }
    const tail = walk(cur, mode);
    if (!changed && tail === cur) return n;
    let acc = tail;
    for (let i = cells.length; i--; ) acc = carrySpan(consCell(ctx, cars[i], acc), cells[i]);
    return acc;
  }
  return walk(node, false);
}
