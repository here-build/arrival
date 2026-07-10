/**
 * Q8a — binding-aware FREE-VARIABLE computation over surface reader forms. The
 * wire-locality law (docs/PROVENANCE.md §7) is `FV(wire body) ⊆ params ∪
 * prelude-names`, checked AT EMISSION — so emission needs a real FV, not
 * `slice.ts`'s deliberately-coarse `referencedSymbols` (which counts BOUND locals
 * and quoted data too; fine for reference-closure, wrong for a locality law: an
 * inner `(let ((y 1)) y)` must not demand `y` from the hermetic env).
 *
 * Scope-aware over exactly the special forms the evaluator dispatches directly and
 * `values/lineage.ts` models (`CLASSIFIED_SPECIAL_FORMS` + `define`/`case`/
 * quasiquote): quote/quasiquote handled as data (unquote re-enters expression
 * space, depth-counted), the binder family (`lambda`, `let`-family incl. named
 * let, `do`, `define`) binds, everything else — including UNMODELED heads — walks
 * as a plain application, which OVER-approximates FV (a free name is never
 * missed; the door may over-trigger on exotic forms, the conservative direction).
 *
 * Non-variables, excluded by construction: keyword symbols (`:foo` — self-typed
 * accessors, not env lookups), gensyms (raw-`symbol` names — uninterned, never an
 * env binding), quoted/vector datum contents.
 */

// Kind-discriminated duck typing over the reader's Pair/Symbol — the same local-copy
// convention prelude.ts documents (slice.ts's private helpers, re-derived per file).
type DuckPair = { car: unknown; cdr: unknown };
type DuckSymbol = { __name__: string | symbol };
const kindOf = (v: unknown): string | undefined =>
  v !== null && typeof v === "object" ? (v as { kind?: string }).kind : undefined;
const isPair = (v: unknown): v is DuckPair => kindOf(v) === "pair";
const isSymbol = (v: unknown): v is DuckSymbol => kindOf(v) === "symbol";

/** Interned symbol's string name; null for a gensym (raw-`symbol` carrier — never a
 *  lexical variable this law governs). */
function nameOf(s: DuckSymbol): string | null {
  return typeof s.__name__ === "string" ? s.__name__ : null;
}

/** Keyword-shaped names (`:foo`, length > 1) are accessors, not variables — mirrors
 *  `values/lineage.ts`'s `memberRead` keyword recognition. */
const isKeywordName = (name: string): boolean => name.length > 1 && name.startsWith(":");

/** The elements of a (possibly improper) pair chain; the dotted tail is appended last. */
function chainOf(n: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = n;
  while (isPair(cur)) {
    out.push(cur.car);
    cur = cur.cdr;
  }
  if (kindOf(cur) !== "nil" && cur !== undefined && cur !== null) out.push(cur);
  return out;
}

/** Formal-parameter names of a lambda formals datum: proper/improper list of symbols,
 *  or a single bare rest symbol. */
function formalNames(formals: unknown): string[] {
  const out: string[] = [];
  if (isSymbol(formals)) {
    const n = nameOf(formals);
    if (n !== null) out.push(n);
    return out;
  }
  let cur: unknown = formals;
  while (isPair(cur)) {
    if (isSymbol(cur.car)) {
      const n = nameOf(cur.car);
      if (n !== null) out.push(n);
    }
    cur = cur.cdr;
  }
  if (isSymbol(cur)) {
    const n = nameOf(cur);
    if (n !== null) out.push(n); // dotted rest formal
  }
  return out;
}

export interface FreeVarsOptions {
  /** Designated subterms the wire emitter CUT to node-egress params — treated as
   *  opaque holes: contribute nothing, never descended (their interiors belong to
   *  other wires/nodes, not this body's FV). Keys are the pair objects themselves. */
  readonly cuts?: ReadonlyMap<unknown, unknown>;
}

/**
 * Free variables of a surface form, in first-encounter order (the emitted wire's
 * param order is derived from it, so determinism matters).
 */
export function freeVars(form: unknown, opts: FreeVarsOptions = {}): Set<string> {
  const out = new Set<string>();
  const seen = new Set<unknown>(); // cyclic-datum guard (mirrors referencedSymbols)

  const walkBody = (body: unknown, bound: ReadonlySet<string>): void => {
    for (const f of chainOf(body)) walk(f, bound);
  };

  const walk = (n: unknown, bound: ReadonlySet<string>): void => {
    if (opts.cuts?.has(n)) return; // a cut hole — another wire's territory
    if (isSymbol(n)) {
      const name = nameOf(n);
      if (name === null || isKeywordName(name)) return;
      if (!bound.has(name)) out.add(name);
      return;
    }
    if (!isPair(n)) return; // literals / vectors / strings — datum, no variables
    if (seen.has(n)) return;
    seen.add(n);

    const head = n.car;
    if (isSymbol(head)) {
      const form_ = nameOf(head);
      // Special-form dispatch only when the head is not locally shadowed.
      if (form_ !== null && !bound.has(form_)) {
        switch (form_) {
          case "quote":
            return; // pure datum
          case "quasiquote": {
            const arg = isPair(n.cdr) ? n.cdr.car : undefined;
            walkQuasi(arg, 1, bound);
            return;
          }
          case "lambda": {
            if (!isPair(n.cdr)) return;
            const params = formalNames(n.cdr.car);
            walkBody(n.cdr.cdr, new Set([...bound, ...params]));
            return;
          }
          case "let": {
            if (!isPair(n.cdr)) return;
            // Named let: (let loop ((v init)…) body…) — loop + vars bound in body;
            // inits evaluate in the OUTER scope.
            if (isSymbol(n.cdr.car)) {
              const loopName = nameOf(n.cdr.car);
              const afterName = n.cdr.cdr;
              if (!isPair(afterName)) return;
              const names: string[] = loopName === null ? [] : [loopName];
              for (const b of chainOf(afterName.car)) {
                if (isPair(b) && isSymbol(b.car)) {
                  const bn = nameOf(b.car);
                  if (bn !== null) names.push(bn);
                  if (isPair(b.cdr)) walk(b.cdr.car, bound);
                }
              }
              walkBody(afterName.cdr, new Set([...bound, ...names]));
              return;
            }
            const names: string[] = [];
            for (const b of chainOf(n.cdr.car)) {
              if (isPair(b) && isSymbol(b.car)) {
                const bn = nameOf(b.car);
                if (bn !== null) names.push(bn);
                if (isPair(b.cdr)) walk(b.cdr.car, bound); // parallel: inits see outer
              }
            }
            walkBody(n.cdr.cdr, new Set([...bound, ...names]));
            return;
          }
          case "let*": {
            if (!isPair(n.cdr)) return;
            let cur = new Set(bound);
            for (const b of chainOf(n.cdr.car)) {
              if (isPair(b) && isSymbol(b.car)) {
                if (isPair(b.cdr)) walk(b.cdr.car, cur); // sequential: init sees priors
                const bn = nameOf(b.car);
                if (bn !== null) cur = new Set([...cur, bn]);
              }
            }
            walkBody(n.cdr.cdr, cur);
            return;
          }
          case "letrec":
          case "letrec*": {
            if (!isPair(n.cdr)) return;
            const names: string[] = [];
            const inits: unknown[] = [];
            for (const b of chainOf(n.cdr.car)) {
              if (isPair(b) && isSymbol(b.car)) {
                const bn = nameOf(b.car);
                if (bn !== null) names.push(bn);
                if (isPair(b.cdr)) inits.push(b.cdr.car);
              }
            }
            const all = new Set([...bound, ...names]); // recursive: all names bind everywhere
            for (const init of inits) walk(init, all);
            walkBody(n.cdr.cdr, all);
            return;
          }
          case "do": {
            // (do ((var init step…)…) (test result…) body…) — inits outer; vars bound
            // for steps/test/results/body.
            if (!isPair(n.cdr)) return;
            const names: string[] = [];
            const laters: unknown[] = [];
            for (const b of chainOf(n.cdr.car)) {
              if (isPair(b) && isSymbol(b.car)) {
                const bn = nameOf(b.car);
                if (bn !== null) names.push(bn);
                const rest = chainOf(b.cdr);
                if (rest.length > 0) walk(rest[0], bound); // init: outer scope
                for (const step of rest.slice(1)) laters.push(step);
              }
            }
            const inner = new Set([...bound, ...names]);
            for (const step of laters) walk(step, inner);
            walkBody(n.cdr.cdr, inner); // (test result…) clause + body commands
            return;
          }
          case "define": {
            if (!isPair(n.cdr)) return;
            const target = n.cdr.car;
            if (isPair(target)) {
              // (define (f . formals) body…)
              const fnName = isSymbol(target.car) ? nameOf(target.car) : null;
              const params = formalNames(target.cdr);
              const inner = new Set([...bound, ...(fnName !== null ? [fnName] : []), ...params]);
              walkBody(n.cdr.cdr, inner);
              return;
            }
            if (isSymbol(target)) {
              const dn = nameOf(target);
              const inner = dn === null ? bound : new Set([...bound, dn]);
              walkBody(n.cdr.cdr, inner);
              return;
            }
            break; // malformed — fall through to application walk
          }
          case "try": {
            // (try body (catch (var) handler…) [(finally expr…)]) — evalTry's exact
            // shape (evaluator.ts); mirrors `static-validation/collect-references.ts`'s
            // "try" arm 1:1 (the local-copy convention both files document — each
            // walker re-derives its own copy of the evaluator's shape rather than
            // sharing one). ONE body form, then clauses. `catch`/`finally` markers are
            // structural literals (`evalTry` recognizes them BY NAME on the raw parsed
            // form, exactly like `cond`'s `else`/`=>`) — never variables, so unlike the
            // unmodeled-head default-arm fallthrough this file used to take for `try`,
            // they must never be added to the free set. The catch VARIABLE binds for
            // its own handlers only. Unrecognized clauses are ignored by the evaluator —
            // skipped here too (walking them would claim crash sites the runtime never
            // runs).
            if (!isPair(n.cdr)) return;
            walk(n.cdr.car, bound);
            for (const clause of chainOf(n.cdr.cdr)) {
              if (!isPair(clause) || !isSymbol(clause.car)) continue;
              const marker = nameOf(clause.car);
              if (marker === "catch") {
                const rest = clause.cdr;
                if (!isPair(rest)) continue;
                const varSpec = rest.car; // (var)
                const varName = isPair(varSpec) && isSymbol(varSpec.car) ? nameOf(varSpec.car) : null;
                const inner = varName === null ? bound : new Set([...bound, varName]);
                walkBody(rest.cdr, inner);
              } else if (marker === "finally") {
                walkBody(clause.cdr, bound);
              }
            }
            return;
          }
          case "cond": {
            for (const clause of chainOf(n.cdr)) {
              if (!isPair(clause)) continue;
              const test = clause.car;
              if (!(isSymbol(test) && nameOf(test) === "else")) walk(test, bound);
              for (const bodyForm of chainOf(clause.cdr)) {
                if (isSymbol(bodyForm) && nameOf(bodyForm) === "=>") continue;
                walk(bodyForm, bound);
              }
            }
            return;
          }
          case "case": {
            const parts = chainOf(n.cdr);
            if (parts.length > 0) walk(parts[0], bound); // the key expression
            for (const clause of parts.slice(1)) {
              if (!isPair(clause)) continue;
              // clause.car is a datum list (or `else`) — data, skipped.
              walkBody(clause.cdr, bound);
            }
            return;
          }
          case "begin":
          case "if":
          case "when":
          case "unless":
          case "and":
          case "or":
          case "set!": {
            // Non-binding special forms: the HEAD is evaluator syntax (always
            // present in the hermetic base), never a variable — walk operands only.
            for (const el of chainOf(n.cdr)) walk(el, bound);
            return;
          }
          default:
            break; // unknown head → application walk below (the op IS a variable)
        }
      }
    }
    // Application (or unmodeled form): every element is expression space — head
    // included (an op name IS a variable reference; base ops resolve hermetically).
    for (const el of chainOf(n)) walk(el, bound);
  };

  /** Quasiquote space: symbols are data except under `unquote`/`unquote-splicing`
   *  at depth 1; nested quasiquote increments depth (R7RS nesting). */
  const walkQuasi = (n: unknown, depth: number, bound: ReadonlySet<string>): void => {
    if (!isPair(n)) return;
    if (seen.has(n)) return;
    seen.add(n);
    const head = n.car;
    if (isSymbol(head)) {
      const hn = nameOf(head);
      if (hn === "unquote" || hn === "unquote-splicing") {
        const arg = isPair(n.cdr) ? n.cdr.car : undefined;
        if (depth === 1) walk(arg, bound);
        else walkQuasi(arg, depth - 1, bound);
        return;
      }
      if (hn === "quasiquote") {
        const arg = isPair(n.cdr) ? n.cdr.car : undefined;
        walkQuasi(arg, depth + 1, bound);
        return;
      }
    }
    for (const el of chainOf(n)) walkQuasi(el, depth, bound);
  };

  walk(form, new Set<string>());
  return out;
}
