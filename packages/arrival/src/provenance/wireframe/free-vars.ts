/**
 * Binding-aware free variables for wire-locality at emission:
 * `FV(body) ⊆ params ∪ prelude-names`. Not `referencedSymbols` (counts bound
 * locals + quoted data — wrong for hermetic demand).
 *
 * Scope-aware over CLASSIFIED_SPECIAL_FORMS + define/case/quasiquote. Unmodeled
 * heads walk as applications (over-approx FV — never miss a free name).
 * Excluded: keywords, gensyms, quoted/vector data.
 */

import { bindingEntries, clauseElements, literalElements } from "../surface.js";

// Local duck Pair/Symbol (same per-file convention as prelude/slice).
type DuckPair = { car: unknown; cdr: unknown };
type DuckSymbol = { __name__: string | symbol };
const kindOf = (v: unknown): string | undefined =>
  v !== null && typeof v === "object" ? (v as { kind?: string }).kind : undefined;
const isPair = (v: unknown): v is DuckPair => kindOf(v) === "pair";
const isSymbol = (v: unknown): v is DuckSymbol => kindOf(v) === "symbol";

function nameOf(s: DuckSymbol): string | null {
  return typeof s.__name__ === "string" ? s.__name__ : null;
}

const isKeywordName = (name: string): boolean => name.length > 1 && name.startsWith(":");

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
  /** Cut subterms are opaque holes — not this body's FV. */
  readonly cuts?: ReadonlyMap<unknown, unknown>;
  /** Bare-name occurrence cuts keyed by the operand cons cell holding the symbol. */
  readonly occurrenceCuts?: ReadonlyMap<unknown, unknown>;
  /** The cons cell holding `form` itself, when `form` is a bare-name occurrence. */
  readonly formCell?: unknown;
}

/** Free names in first-encounter order (drives wire param order). */
export function freeVars(form: unknown, opts: FreeVarsOptions = {}): Set<string> {
  const out = new Set<string>();
  const seen = new Set<unknown>();

  const walkBody = (body: unknown, bound: ReadonlySet<string>): void => {
    walkCells(body, bound);
  };

  const walk = (n: unknown, bound: ReadonlySet<string>, cell?: unknown): void => {
    if (opts.cuts?.has(n)) return;
    if (isSymbol(n)) {
      if (cell !== undefined && opts.occurrenceCuts?.has(cell)) return; // cut bare-name occurrence
      const name = nameOf(n);
      if (name === null || isKeywordName(name)) return;
      if (!bound.has(name)) out.add(name);
      return;
    }
    if (!isPair(n)) {
      // `[…]` / `{…}` literals are EVALUATED (their elements are expressions).
      const els = literalElements(n);
      if (els !== undefined && !seen.has(n)) {
        seen.add(n);
        for (const el of els) walk(el, bound);
      }
      return;
    }
    if (seen.has(n)) return;
    seen.add(n);

    const head = n.car;
    if (isSymbol(head)) {
      const form_ = nameOf(head);
      if (form_ !== null && !bound.has(form_)) {
        switch (form_) {
          case "quote":
            return;
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
            if (isSymbol(n.cdr.car)) {
              const loopName = nameOf(n.cdr.car);
              const afterName = n.cdr.cdr;
              if (!isPair(afterName)) return;
              const names: string[] = loopName === null ? [] : [loopName];
              for (const b of bindingEntries(afterName.car)) {
                names.push(b.name);
                if (b.rest.length > 0) walk(b.rest[0], bound, b.cells?.[0]);
              }
              walkBody(afterName.cdr, new Set([...bound, ...names]));
              return;
            }
            const names: string[] = [];
            for (const b of bindingEntries(n.cdr.car)) {
              names.push(b.name);
              if (b.rest.length > 0) walk(b.rest[0], bound, b.cells?.[0]);
            }
            walkBody(n.cdr.cdr, new Set([...bound, ...names]));
            return;
          }
          case "let*": {
            if (!isPair(n.cdr)) return;
            let cur = new Set(bound);
            for (const b of bindingEntries(n.cdr.car)) {
              if (b.rest.length > 0) walk(b.rest[0], cur, b.cells?.[0]);
              cur = new Set([...cur, b.name]);
            }
            walkBody(n.cdr.cdr, cur);
            return;
          }
          case "letrec":
          case "letrec*": {
            if (!isPair(n.cdr)) return;
            const names: string[] = [];
            const inits: { form: unknown; cell: unknown }[] = [];
            for (const b of bindingEntries(n.cdr.car)) {
              names.push(b.name);
              if (b.rest.length > 0) inits.push({ form: b.rest[0], cell: b.cells?.[0] });
            }
            const all = new Set([...bound, ...names]);
            for (const init of inits) walk(init.form, all, init.cell);
            walkBody(n.cdr.cdr, all);
            return;
          }
          case "do": {
            if (!isPair(n.cdr)) return;
            const names: string[] = [];
            const laters: unknown[] = [];
            for (const b of bindingEntries(n.cdr.car, false)) {
              names.push(b.name);
              if (b.rest.length > 0) walk(b.rest[0], bound, b.cells?.[0]);
              for (const step of b.rest.slice(1)) laters.push(step);
            }
            const inner = new Set([...bound, ...names]);
            for (const step of laters) walk(step, inner);
            // test clause `(test result…)` (or bracket) is evaluated in the loop scope;
            // then the per-iteration commands.
            const afterBindings = n.cdr.cdr;
            if (isPair(afterBindings)) {
              for (const el of clauseElements(afterBindings.car) ?? []) walk(el, inner);
              walkBody(afterBindings.cdr, inner);
            }
            return;
          }
          case "define": {
            if (!isPair(n.cdr)) return;
            const target = n.cdr.car;
            if (isPair(target)) {
              const fnName = isSymbol(target.car) ? nameOf(target.car) : null;
              const params = formalNames(target.cdr);
              const inner = new Set([
                ...bound,
                // eslint-disable-next-line unicorn/no-negated-condition -- include the define name only when it is a symbol
                ...(fnName !== null ? [fnName] : []),
                ...params,
              ]);
              walkBody(n.cdr.cdr, inner);
              return;
            }
            if (isSymbol(target)) {
              const dn = nameOf(target);
              const inner = dn === null ? bound : new Set([...bound, dn]);
              walkBody(n.cdr.cdr, inner);
              return;
            }
            break;
          }
          case "try": {
            // Explicit shape so catch/finally markers are not free names.
            // Catch var binds only its handlers.
            if (!isPair(n.cdr)) return;
            walk(n.cdr.car, bound, n.cdr);
            for (const clause of chainOf(n.cdr.cdr)) {
              if (!isPair(clause) || !isSymbol(clause.car)) continue;
              const marker = nameOf(clause.car);
              if (marker === "catch") {
                const rest = clause.cdr;
                if (!isPair(rest)) continue;
                const varSpec = rest.car;
                const varName = isPair(varSpec) && isSymbol(varSpec.car) ? nameOf(varSpec.car) : null;
                const inner = varName === null ? bound : new Set([...bound, varName]);
                walkBody(rest.cdr, inner);
              } else if (marker === "finally") {
                walkBody(clause.cdr, bound);
              }
            }
            return;
          }
          case "guard": {
            // (guard (var clause…) body…): body in the outer scope; var binds in the clauses only.
            if (!isPair(n.cdr)) return;
            const spec = n.cdr.car;
            if (isPair(spec)) {
              const varName = isSymbol(spec.car) ? nameOf(spec.car) : null;
              const inner = varName === null ? bound : new Set([...bound, varName]);
              walkCondClauses(spec.cdr, inner);
            }
            walkBody(n.cdr.cdr, bound);
            return;
          }
          case "cond": {
            walkCondClauses(n.cdr, bound);
            return;
          }
          case "case": {
            const parts = chainOf(n.cdr);
            if (parts.length > 0) walk(parts[0], bound, n.cdr);
            for (const clause of parts.slice(1)) {
              const els = clauseElements(clause);
              if (els === undefined) continue;
              els.forEach((bodyForm, i) => {
                if (i === 0) return;
                let cell: unknown;
                if (isPair(clause)) {
                  cell = clause;
                  for (let k = 0; k < i && isPair(cell); k++) cell = (cell as DuckPair).cdr;
                }
                walk(bodyForm, bound, cell);
              });
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
            walkCells(n.cdr, bound);
            return;
          }
          default:
            break;
        }
      }
    }
    walkCells(n, bound);
  };

  /** Walk a chain by CELL (bare-name occurrence cuts are keyed per cell); dotted tail too. */
  const walkCells = (list: unknown, bound: ReadonlySet<string>): void => {
    let cur: unknown = list;
    while (isPair(cur)) {
      walk(cur.car, bound, cur);
      cur = cur.cdr;
    }
    if (kindOf(cur) !== "nil" && cur !== undefined && cur !== null) walk(cur, bound);
  };

  const walkCondClauses = (clauses: unknown, bound: ReadonlySet<string>): void => {
    for (const clause of chainOf(clauses)) {
      const parts = clauseElements(clause);
      if (parts === undefined || parts.length === 0) continue;
      // Paren clauses expose their cons cells (bare-name occurrence cuts are keyed per cell).
      const cellOf = (i: number): unknown => {
        if (!isPair(clause)) return undefined;
        let cur: unknown = clause;
        for (let k = 0; k < i && isPair(cur); k++) cur = (cur as DuckPair).cdr;
        return cur;
      };
      const test = parts[0];
      if (!(isSymbol(test) && nameOf(test) === "else")) walk(test, bound, cellOf(0));
      parts.forEach((bodyForm, i) => {
        if (i === 0) return;
        if (isSymbol(bodyForm) && nameOf(bodyForm) === "=>") return;
        walk(bodyForm, bound, cellOf(i));
      });
    }
  };

  /** Quasiquote: unquote at depth 1 re-enters expression space (R7RS nesting). */
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

  walk(form, new Set<string>(), opts.formCell);
  return out;
}
