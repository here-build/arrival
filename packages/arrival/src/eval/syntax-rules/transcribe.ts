// ----------------------------------------------------------------------
// syntax-rules TEMPLATE TRANSCRIBER — R7RS §4.3.2, with the HYGIENE layer.
//
// Walks a template against the binding tree match.ts produced. `<sub> ...` is driven by the
// pattern variables occurring in <sub> whose binding is still repeated at this level (a
// variable's `Rep.depth` exceeds the number of ellipses wrapping its occurrence inside <sub>);
// all driving variables must have the same repetition count. Variables of lower depth are
// constants across iterations. `<sub> ... ...` flattens one more level. `(... <template>)`
// instantiates <template> with ellipses treated as ordinary identifiers; a custom ellipsis
// identifier comes in through `ellipsis`.
//
// HYGIENE: every template-introduced identifier is renamed to a gensym (rename()), with the
// def-time binding copied onto it, and recorded in `names` so restore_data_gensyms can
// un-rename DATA positions. Vector templates `#(…)` are constants: their free identifiers
// are left alone (only pattern variables substitute).
//
// SPAN PROPAGATION: every pair this module mints is stamped with the span of the template
// node it was built from (carrySpan); substituted pattern variables ride by reference.
//
// Attribution: derived from LIPS Scheme (Jakub T. Jankiewicz) — see LICENSE.
// ----------------------------------------------------------------------
import type { RunContext } from "../../run/RunContext.js";
import type { Resolver } from "../Resolver.js";
import type { LexicalScopeWithInternals } from "../LexicalScope.js";
import { EvalError } from "../../errors.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { AVector } from "../../values/primitives/AVector.js";
import { APair } from "../../values/primitives/APair.js";
import { ANil, nil } from "../../values/primitives/ANil.js";
import type { SchemeValue } from "../../values/types.js";
import { gensym } from "../../values/values-repr.js";
import { Macro } from "../Macro.js";
import { carrySpan, consCell, listFromArray, type Pair } from "./mint.js";
import { ellipsisIsLiteral, newBindings, Rep, type Bindings, type EllipsisId } from "./match.js";

// The renamed-gensym record kept so `restore_data_gensyms` can un-rename DATA positions.
export interface GensymRecord {
  name: string | symbol;
  gensym: ASymbol;
}

// `transform_syntax`'s options — the template (`expr`), the matcher output (`bindings`),
// the literal-`symbols` name-list, the def-time syntax-child RESOLVER (`scope`), the
// `names` accumulator, and the `ellipsis` marker. Plain JS handles, not SchemeValues.
export interface TransformOptions {
  bindings: Bindings;
  expr: SchemeValue;
  scope: Resolver;
  symbols: unknown[];
  names: GensymRecord[];
  ellipsis: EllipsisId;
  /** The live per-run context — every template-instantiation mint goes through it, so
   *  expansion output carries the run's identity and charges its meter. */
  ctx: RunContext;
}

interface Mode {
  /** `(... t)` escape: the ellipsis identifier is an ordinary identifier. */
  disabled: boolean;
  /** Inside a `#(…)` constant: identifiers are not renamed. */
  raw: boolean;
}
const CODE: Mode = { disabled: false, raw: false };

const names_ = (names: Iterable<string | symbol>) => [...names].map((n) => String(n)).join(", ");

class Transcriber {
  private readonly gensyms: Record<string | symbol, ASymbol> = Object.create(null);
  /** Per-template-node cache of {variable → deepest ellipsis nesting inside the node}. */
  private readonly depthCache = new WeakMap<object, Map<string | symbol, number>>();
  private readonly nestedCache = new WeakMap<object, boolean>();
  private readonly defChild: LexicalScopeWithInternals<Resolver>;

  constructor(private readonly o: TransformOptions) {
    // `scope` is the def-time syntax-child RESOLVER (`defResolver.child("syntax")`); the
    // engine consults its refFrame/lookupSettled/define instead of raw env .ref/.get/.set.
    this.defChild = o.scope as LexicalScopeWithInternals<Resolver>;
    this.ellipsisLiteral = ellipsisIsLiteral(o.symbols, o.ellipsis);
  }

  private get ctx() {
    return this.o.ctx;
  }

  private readonly ellipsisLiteral: boolean;

  private isEllipsis(x: unknown): boolean {
    return !this.ellipsisLiteral && ASymbol.is(x, this.o.ellipsis);
  }

  // ---- hygiene -------------------------------------------------------------------

  private transform(symbol: ASymbol): SchemeValue {
    const name = symbol.valueOf();
    return this.o.symbols.includes(name) ? symbol : this.rename(name, symbol);
  }

  /** Rename a template-introduced identifier to a gensym carrying its def-time binding.
   *  Resolution order (hygiene): (1) the identifier ITSELF — a nested macro's template names a
   *  gensym an outer expansion introduced, and that binding lives under the gensym; (2) on a
   *  miss, for a gensym, its ORIGINAL literal (a nested template that names an ordinary free
   *  identifier); (3) the c[ad]+r family, which the resolver synthesizes rather than binds.
   *  An identifier that resolves nowhere is a free reference: renamed, bound to nothing, and
   *  unbound at use — it never resolves to a use-site binding of the same name. */
  private rename(name: string | symbol, symbol: ASymbol): ASymbol {
    const cached = this.gensyms[name];
    if (cached) return cached;
    let key = name;
    let value = this.defChild.lookupSettled(name);
    if (value === undefined && typeof name === "symbol") {
      key = symbol.literal();
      if (this.gensyms[key]) return this.gensyms[key];
      value = this.defChild.lookupSettled(key);
    }
    value ??= this.defChild.synthesize(key);
    const gensym_name = gensym(symbol.literal());
    // Copy the bound value (if any) onto the gensym so the expansion resolves it.
    if (value !== undefined) this.defChild.env.bind(gensym_name, value);
    // Record the rename so restore_data_gensyms can un-rename the data positions.
    this.o.names.push({ name: symbol.literal(), gensym: gensym_name });
    this.gensyms[key] = gensym_name;
    if (key !== name) this.gensyms[name] = gensym_name;
    return gensym_name;
  }

  // ---- ellipsis driving ----------------------------------------------------------

  /** {variable → deepest ellipsis nesting at which it occurs inside `t`} for variables bound
   *  in `env`. Mirrors expand()'s reading of the template (escapes, ellipsis runs). */
  private occurrenceDepths(t: SchemeValue, env: Bindings): Map<string | symbol, number> {
    const cached = typeof t === "object" ? this.depthCache.get(t) : undefined;
    if (cached) return cached;
    const out = new Map<string | symbol, number>();
    this.collectDepths(t, 0, false, env, out);
    if (typeof t === "object") this.depthCache.set(t, out);
    return out;
  }

  private collectDepths(
    t: SchemeValue,
    depth: number,
    disabled: boolean,
    env: Bindings,
    out: Map<string | symbol, number>,
  ): void {
    if (t instanceof ASymbol) {
      const name = t.valueOf();
      if (env[name] !== undefined) out.set(name, Math.max(out.get(name) ?? 0, depth));
    } else if (t instanceof AVector) {
      this.collectSpine(listFromArray(this.ctx, t.__vector__), depth, disabled, env, out);
    } else if (t instanceof APair) {
      if (!disabled && this.isEllipsis(t.car) && t.cdr instanceof APair) {
        this.collectDepths(t.cdr.car, depth, true, env, out);
      } else {
        this.collectSpine(t, depth, disabled, env, out);
      }
    }
  }

  private collectSpine(
    list: SchemeValue,
    depth: number,
    disabled: boolean,
    env: Bindings,
    out: Map<string | symbol, number>,
  ): void {
    let cur: SchemeValue = list;
    while (cur instanceof APair) {
      let next: SchemeValue = cur.cdr;
      let runs = 0;
      while (!disabled && next instanceof APair && this.isEllipsis(next.car)) {
        runs++;
        next = next.cdr;
      }
      this.collectDepths(cur.car, depth + runs, disabled, env, out);
      cur = next;
    }
    this.collectDepths(cur, depth, disabled, env, out);
  }

  /** The variables that drive `sub ...`: still repeated at this level. */
  private drivers(sub: SchemeValue, env: Bindings): (string | symbol)[] {
    const driven: (string | symbol)[] = [];
    for (const [name, inner] of this.occurrenceDepths(sub, env)) {
      const b = env[name];
      if (b instanceof Rep && b.depth > inner) driven.push(name);
    }
    return driven;
  }

  /** Instantiate `sub` once per repetition, through `runs` stacked ellipses (`sub ... ...`). */
  private expandRepeated(sub: SchemeValue, env: Bindings, runs: number, mode: Mode): SchemeValue[] {
    const driven = this.drivers(sub, env);
    if (driven.length === 0) {
      throw new EvalError("syntax-rules: no pattern variable to repeat under `...` in template", {
        hint: "an ellipsis in a template must follow a sub-template containing a pattern variable that the pattern matched with `...`",
      });
    }
    const reps = driven.map((n) => env[n] as Rep);
    const len = reps[0].items.length;
    if (reps.some((r) => r.items.length !== len)) {
      throw new EvalError(
        `syntax-rules: pattern variables ${names_(driven)} are repeated different numbers of times (${reps
          .map((r) => r.items.length)
          .join(" vs ")}) under one \`...\``,
        { hint: "variables expanded together under one ellipsis must have matched the same number of repetitions" },
      );
    }
    const out: SchemeValue[] = [];
    for (let i = 0; i < len; i++) {
      const inner: Bindings = Object.assign(newBindings(), env);
      driven.forEach((n, k) => {
        inner[n] = reps[k].items[i];
      });
      if (runs > 1) out.push(...this.expandRepeated(sub, inner, runs - 1, mode));
      else out.push(this.expand(sub, inner, mode));
    }
    return out;
  }

  // ---- expansion -----------------------------------------------------------------

  expand(t: SchemeValue, env: Bindings, mode: Mode): SchemeValue {
    if (t instanceof ASymbol) return this.expandSymbol(t, env, mode);
    if (t instanceof APair) return this.expandPair(t, env, mode);
    if (t instanceof AVector) return this.expandVector(t, env, mode);
    return t;
  }

  private expandSymbol(t: ASymbol, env: Bindings, mode: Mode): SchemeValue {
    if (this.isEllipsis(t)) {
      if (mode.disabled) return t;
      throw new EvalError("syntax-rules: misplaced `...` in template", {
        hint: "`...` must follow a sub-template; to emit a literal `...` write (... ...)",
      });
    }
    const bound = env[t.valueOf()];
    if (bound instanceof Rep) {
      throw new EvalError(`syntax-rules: missing ellipsis symbol next to name \`${t.literal()}'`, {
        hint: `pattern variable ${t.literal()} was matched with ${bound.depth} level(s) of \`...\`; follow it with that many \`...\` in the template`,
      });
    }
    if (bound !== undefined) return bound;
    return mode.raw ? t : this.transform(t);
  }

  private expandVector(t: AVector, env: Bindings, mode: Mode): SchemeValue {
    const list = this.expandPair(listFromArray(this.ctx, t.__vector__), env, {
      ...mode,
      raw: mode.raw || !t.evalElements,
    });
    const items: SchemeValue[] = [];
    let cur: SchemeValue = list;
    while (cur instanceof APair) {
      items.push(cur.car);
      cur = cur.cdr;
    }
    const v = new AVector(items, t.provenance, t.location);
    v.evalElements = t.evalElements;
    return v;
  }

  private expandPair(t: Pair | ANil, env: Bindings, mode: Mode): SchemeValue {
    if (!(t instanceof APair)) return t;
    if (!mode.disabled && this.isEllipsis(t.car)) {
      // Escape `(... <template>)`.
      if (t.cdr instanceof APair && t.cdr.cdr instanceof ANil) {
        return this.expand(t.cdr.car, env, { ...mode, disabled: true });
      }
      throw new EvalError("syntax-rules: misplaced `...` in template", {
        hint: "`...` must follow a sub-template; to emit a literal `...` write (... ...)",
      });
    }
    if (!mode.disabled && t.cdr instanceof APair && this.isEllipsis(t.cdr.car)) {
      return this.expandEllipsisRun(t, env, mode);
    }
    const head = this.expand(t.car, env, mode);
    const rest = this.isNestedSyntaxRules(t)
      ? this.expandNestedRules(t.cdr as Pair, env, mode)
      : this.expand(t.cdr, env, mode);
    return carrySpan(consCell(this.ctx, head, rest), t);
  }

  /** `(sub ... rest)`: instantiate sub per repetition, then the rest of the list. */
  private expandEllipsisRun(t: Pair, env: Bindings, mode: Mode): SchemeValue {
    let after: SchemeValue = t.cdr;
    let runs = 0;
    while (after instanceof APair && this.isEllipsis(after.car)) {
      runs++;
      after = after.cdr;
    }
    const items = this.expandRepeated(t.car, env, runs, mode);
    let acc = this.expand(after, env, mode);
    for (let i = items.length; i--; ) {
      acc = carrySpan(consCell(this.ctx, items[i], acc), t);
    }
    return acc;
  }

  // A template that builds a nested `(syntax-rules …)`: its literals list is DATA for the inner
  // macro (kept raw — literals are compared by name), the rest is transcribed normally.
  // Memoized per template node: the answer is a def-time fact, asked once per instantiation.
  private isNestedSyntaxRules(t: Pair): boolean {
    const cached = this.nestedCache.get(t);
    if (cached !== undefined) return cached;
    const value = t.car instanceof ASymbol && t.cdr instanceof APair ? this.defChild.lookupSettled(t.car) : undefined;
    const is = value instanceof Macro && value.__name__ === "syntax-rules";
    this.nestedCache.set(t, is);
    return is;
  }

  private expandNestedRules(args: Pair, env: Bindings, mode: Mode): SchemeValue {
    if (args.car instanceof ASymbol) {
      // (syntax-rules ::: (lits) rule …): the custom ellipsis is renamed like any identifier.
      const ell = this.expand(args.car, env, mode);
      const afterEll = args.cdr;
      const inner =
        afterEll instanceof APair
          ? carrySpan(consCell(this.ctx, afterEll.car, this.expand(afterEll.cdr, env, mode)), afterEll)
          : nil;
      return carrySpan(consCell(this.ctx, ell, inner), args);
    }
    return carrySpan(consCell(this.ctx, args.car, this.expand(args.cdr, env, mode)), args);
  }

  run(): SchemeValue {
    return this.expand(this.o.expr, this.o.bindings, CODE);
  }
}

export function transform_syntax(options: TransformOptions): SchemeValue {
  return new Transcriber(options).run();
}
