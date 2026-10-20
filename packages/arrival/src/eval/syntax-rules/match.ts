// ----------------------------------------------------------------------
// syntax-rules PATTERN MATCHER — R7RS §4.3.2.
//
// A match produces a BINDING TREE: every pattern variable is bound at its ELLIPSIS DEPTH.
// Depth 0 → the matched form itself; depth k → a `Rep` whose items are the depth-(k-1)
// bindings, one per repetition. The transcriber (transcribe.ts) walks templates and drives
// ellipsis expansion by the variables occurring under each `...`.
//
// A pattern list (or vector) is decomposed into a SEQ — its elements plus the terminal
// (nil, or the improper tail). One ellipsis per level is allowed (R7RS); elements before it
// match the head, elements after it match the FIXED TAIL (`p ... q r`), and the ellipsis
// greedily takes everything in between. The terminal then matches what is left of the form
// (`(x ... . rest)`, `(a b . rest)`).
//
// EVALUATE-FREE. Spine cells of the user's form are never mutated or copied: a variable
// bound to a list remainder is the original cell, spans intact.
//
// Attribution: derived from LIPS Scheme (Jakub T. Jankiewicz) — see LICENSE.
// ----------------------------------------------------------------------
import type { Resolver } from "../Resolver.js";
import type { Capabilities } from "../Capabilities.js";
import { EvalError } from "../../errors.js";
import { AString } from "../../values/primitives/AString.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { AValue } from "../../values/primitives/AValue.js";
import { AVector } from "../../values/primitives/AVector.js";
import { APair } from "../../values/primitives/APair.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import { eqv } from "../../values/structural-equal.js";
import type { SchemeValue } from "../../values/types.js";
import { type } from "../../membrane/typecheck.js";
import { is_atom } from "../../values/values-repr.js";
import type { Pair } from "./mint.js";

/** One ellipsis level of a binding: `items[i]` is the binding for repetition i. `depth` is the
 *  variable's total ellipsis depth (≥ 1) — recorded statically so an EMPTY repetition still
 *  knows how deeply it nests. */
export class Rep {
  constructor(
    readonly items: readonly Binding[],
    readonly depth: number,
  ) {}
}
export type Binding = SchemeValue | Rep;
/** Pattern-variable → binding. NULL-PROTOTYPE: keys are user-controlled names, so a variable
 *  called `toString`/`constructor`/`__proto__` must not collide with Object.prototype. */
export type Bindings = Record<string | symbol, Binding>;

export function newBindings(): Bindings {
  return Object.create(null);
}

// The hygiene-identity handles the syntax-rules caller injects. Plain JS resolver handles,
// NOT SchemeValues.
export interface HygieneScope {
  useResolver: Resolver;
  defResolver: Resolver;
  capabilities: Capabilities;
}

export type EllipsisId = string | ASymbol;

/** A list/vector pattern or form decomposed: its elements, and what follows them. */
export interface Seq {
  items: SchemeValue[];
  /** Terminal after the last element: nil for a proper list / vector, else the dotted tail. */
  tail: SchemeValue;
  /** The form remaining after the first `k` elements (the original cell — no copy). A vector
   *  has no remainder to hand on: `undefined` — the elements must all be consumed. */
  rest: ((k: number) => SchemeValue) | undefined;
}

export function seqOfPair(x: Pair): Seq {
  const cells: Pair[] = [];
  let cur: unknown = x;
  while (cur instanceof APair) {
    cells.push(cur);
    cur = cur.cdr;
  }
  const tail = cur as SchemeValue;
  return {
    items: cells.map((c) => c.car),
    tail,
    rest: (k) => (k < cells.length ? cells[k] : tail),
  };
}

export function seqOfVector(v: AVector): Seq {
  return { items: [...v.__vector__], tail: nil, rest: undefined };
}

const EMPTY_SEQ: Seq = { items: [], tail: nil, rest: () => nil };

// The type()-vs-kind fold for same_atom's discriminator: `a` is always a boxed AValue atom
// here, but `b` (the code fragment being matched) can still be a raw JS string/RegExp.
// Reading `.kind` directly is the "kind-equality" collapse: AExact and AInexact both carry
// kind "number", so `(= 1 1.0)`-shaped literal comparisons collapse without a tower special case.
function atomKind(x: unknown): string {
  return x instanceof AValue ? x.kind : type(x);
}

function same_atom(a, b) {
  if (atomKind(a) !== atomKind(b) || !is_atom(a)) {
    return false;
  }
  if (a instanceof RegExp) {
    return a.source === b.source;
  }
  if (a instanceof AString) {
    return b instanceof AString && a.valueOf() === b.valueOf();
  }
  return eqv(a, b);
}

interface Segment {
  pat: SchemeValue;
  rep: boolean;
}

/** R7RS §4.3.2: an ellipsis identifier that is listed among the literals is an ordinary
 *  literal, not an ellipsis ("literal has priority"). */
export function ellipsisIsLiteral(literals: readonly unknown[], ellipsis: EllipsisId): boolean {
  return literals.includes(ellipsis instanceof ASymbol ? ellipsis.literal() : ellipsis);
}

/** Pattern nodes already proven free of duplicate pattern variables. */
const linear = new WeakSet<object>();

export class Matcher {
  private readonly ellipsisLiteral: boolean;

  constructor(
    private readonly literals: readonly unknown[],
    private readonly ellipsis: EllipsisId,
    private readonly scope: HygieneScope,
  ) {
    this.ellipsisLiteral = ellipsisIsLiteral(literals, ellipsis);
  }

  isEllipsis(x: unknown): boolean {
    return !this.ellipsisLiteral && ASymbol.is(x, this.ellipsis);
  }

  /** Top-level entry. R7RS §4.3.2: the keyword position of a rule's pattern is neither a
   *  pattern variable nor a literal — it is ignored, whatever it is spelled. */
  matchForm(pattern: SchemeValue, form: unknown, out: Bindings): boolean {
    if (pattern instanceof APair && form instanceof APair) {
      this.assertLinear(pattern.cdr);
      return this.match(pattern.cdr, form.cdr, out);
    }
    this.assertLinear(pattern);
    return this.match(pattern, form, out);
  }

  /** R7RS §4.3.2: a pattern variable occurs at most once in a pattern ("it is an error"). Checked
   *  once per pattern node — literals and ellipsis are fixed per macro. */
  private assertLinear(pattern: SchemeValue): void {
    if (typeof pattern !== "object" || linear.has(pattern)) return;
    const seen = new Set<string | symbol>();
    const visit = (pat: SchemeValue): void => {
      if (pat instanceof ASymbol) {
        if (this.isLiteral(pat) || this.isEllipsis(pat) || pat.literal() === "_") return;
        const name = pat.valueOf();
        if (seen.has(name)) {
          throw new EvalError(`syntax-rules: pattern variable \`${pat.literal()}' occurs more than once in a pattern`, {
            hint: "bind each pattern variable once and compare the captured values in the template, e.g. (if (equal? a b) …)",
          });
        }
        seen.add(name);
      } else if (pat instanceof APair || pat instanceof AVector) {
        const seq = this.seqOf(pat);
        seq.items.forEach(visit);
        visit(seq.tail);
      }
    };
    visit(pattern);
    linear.add(pattern);
  }

  private isLiteral(sym: ASymbol): boolean {
    return this.literals.includes(sym.literal());
  }

  /** Pattern variables of `pat` with their ellipsis depth (R7RS: literals, `_` and the
   *  ellipsis identifier are not variables). */
  patternVars(pat: SchemeValue, depth = 0, out = new Map<string | symbol, number>()): Map<string | symbol, number> {
    if (pat instanceof ASymbol) {
      if (!this.isLiteral(pat) && !this.isEllipsis(pat) && pat.literal() !== "_") out.set(pat.valueOf(), depth);
    } else if (pat instanceof APair || pat instanceof AVector) {
      const seq = this.seqOf(pat);
      for (const seg of this.segments(seq.items)) this.patternVars(seg.pat, depth + (seg.rep ? 1 : 0), out);
      this.patternVars(seq.tail, depth, out);
    }
    return out;
  }

  private seqOf(x: Pair | AVector): Seq {
    return x instanceof APair ? seqOfPair(x) : seqOfVector(x);
  }

  private segments(items: readonly SchemeValue[]): Segment[] {
    const segs: Segment[] = [];
    for (const item of items) {
      if (!this.isEllipsis(item)) {
        segs.push({ pat: item, rep: false });
        continue;
      }
      const prev = segs[segs.length - 1];
      if (prev === undefined || prev.rep) {
        throw new EvalError("syntax-rules: `...` must follow a pattern", {
          hint: "write `(x ...)`; to match a literal ellipsis declare a custom one: (syntax-rules ::: (lits) ...)",
        });
      }
      prev.rep = true;
    }
    return segs;
  }

  match(pattern: SchemeValue, form: unknown, out: Bindings): boolean {
    if (pattern instanceof ASymbol) return this.matchSymbol(pattern, form, out);
    if (pattern instanceof APair) {
      // A pair pattern also matches nil (all its elements may be empty repetitions).
      if (form instanceof APair) return this.matchSeq(seqOfPair(pattern), seqOfPair(form), out);
      return form instanceof ANil && this.matchSeq(seqOfPair(pattern), EMPTY_SEQ, out);
    }
    if (pattern instanceof AVector) {
      return form instanceof AVector && this.matchSeq(seqOfVector(pattern), seqOfVector(form), out);
    }
    if (pattern instanceof ANil) return form instanceof ANil;
    return same_atom(pattern, form);
  }

  private matchSymbol(pattern: ASymbol, form: unknown, out: Bindings): boolean {
    if (this.isLiteral(pattern)) return this.matchLiteral(pattern, form);
    if (this.isEllipsis(pattern)) {
      throw new EvalError("syntax-rules: misplaced `...` in pattern", {
        hint: "an ellipsis must follow a sub-pattern: `(x ...)`",
      });
    }
    if (pattern.literal() !== "_") out[pattern.valueOf()] = form as SchemeValue;
    return true;
  }

  private matchLiteral(pattern: ASymbol, code: unknown): boolean {
    const literal = pattern.literal();
    const codeAsName = code instanceof ASymbol || typeof code === "string" || code instanceof RegExp;
    if (!ASymbol.is(code, literal) && !(codeAsName && ASymbol.is(pattern, code as ASymbol | string | RegExp))) {
      return false;
    }
    // refFrame walks USE-site scope frames THEN capabilities, returning the owning frame
    // (a LexicalScope for a lexical owner, the globalRoot env for an unshadowed builtin).
    // unbound (!ref) and unshadowed-base (=== globalRoot) match; `=== defResolver.scope`
    // compares the captured def frame. A literal shadowed by an intervening user `let`
    // returns that user frame (≠ both) → no match.
    const { useResolver, defResolver, capabilities } = this.scope;
    const ref = useResolver.refFrame(literal);
    return !ref || ref === defResolver.scope || ref === capabilities.globalRoot;
  }

  private matchSeq(p: Seq, f: Seq, out: Bindings): boolean {
    const segs = this.segments(p.items);
    const at = segs.findIndex((s) => s.rep);
    if (at !== segs.findLastIndex((s) => s.rep)) {
      throw new EvalError("syntax-rules: more than one `...` at the same level of a pattern", {
        hint: "R7RS allows one ellipsis per list; nest the second: ((a ...) ...)",
      });
    }
    const head = at < 0 ? segs : segs.slice(0, at);
    const tail = at < 0 ? [] : segs.slice(at + 1);
    const fixed = head.length + tail.length;
    if (f.items.length < fixed) return false;
    if (!this.matchFixed(head, f.items, 0, out)) return false;
    const count = at < 0 ? 0 : f.items.length - fixed;
    if (at >= 0 && !this.matchRepeated(segs[at], f.items.slice(head.length, head.length + count), out)) return false;
    if (!this.matchFixed(tail, f.items, head.length + count, out)) return false;
    const used = head.length + count + tail.length;
    return f.rest === undefined ? used === f.items.length : this.match(p.tail, f.rest(used), out);
  }

  private matchFixed(segs: readonly Segment[], items: readonly SchemeValue[], from: number, out: Bindings): boolean {
    return segs.every((seg, i) => this.match(seg.pat, items[from + i], out));
  }

  private matchRepeated(seg: Segment, items: readonly SchemeValue[], out: Bindings): boolean {
    const subs: Bindings[] = [];
    for (const item of items) {
      const sub = newBindings();
      if (!this.match(seg.pat, item, sub)) return false;
      subs.push(sub);
    }
    for (const [name, depth] of this.patternVars(seg.pat)) {
      out[name] = new Rep(
        subs.map((s) => s[name]),
        depth + 1,
      );
    }
    return true;
  }
}

/** Match `code` against `pattern`. Returns the binding tree, or undefined when no match.
 *  deferred: no cycle detection — a self-referential pattern/code pair can loop the matcher. */
export function extract_patterns(
  pattern: unknown,
  code: unknown,
  symbols: unknown[],
  ellipsis_symbol: EllipsisId,
  scope: HygieneScope,
): Bindings | undefined {
  const bindings = newBindings();
  return new Matcher(symbols, ellipsis_symbol, scope).matchForm(pattern as SchemeValue, code, bindings)
    ? bindings
    : undefined;
}
