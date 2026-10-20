/**
 * Static reads of the EVALUATED bracket/curly surface, shared by the classifier
 * (`lineage.ts`), the free-variable walk, and the wireframe builder. A static pre-execution
 * twin of the evaluator's `normalizeBindings` / `normalizeClause` (evaluator.ts, §BINDINGS /
 * §CLAUSES) — it must agree with them on what a binder/clause LOOKS like, because a form the
 * static plane cannot read is a port it cannot see (P-A: any accepted code is representable).
 *
 * Duck-typed on the authoritative `kind` tag, like `slice.ts` (this module imports no value
 * classes). `[…]` (vector with `evalElements`) and `{…}` (dict with `literalForms`) are
 * EVALUATED forms — their elements are expressions, not quoted data.
 */

type DuckPair = { car: unknown; cdr: unknown };
type DuckSymbol = { __name__: string | symbol };
const kindOf = (v: unknown): string | undefined =>
  v !== null && typeof v === "object" ? (v as { kind?: string }).kind : undefined;
const isPair = (v: unknown): v is DuckPair => kindOf(v) === "pair";
const isSymbol = (v: unknown): v is DuckSymbol => kindOf(v) === "symbol";
const symName = (s: DuckSymbol): string =>
  typeof s.__name__ === "string" ? s.__name__ : (s.__name__.description ?? String(s.__name__));

/** Proper-list elements of a pair chain (improper tail ignored). */
function chain(n: unknown): unknown[] {
  const out: unknown[] = [];
  let cur: unknown = n;
  while (isPair(cur)) {
    out.push(cur.car);
    cur = cur.cdr;
  }
  return out;
}

/** The expression elements of an evaluated `[…]` vector or `{…}` dict literal; `undefined`
 *  for anything else (a `#(…)` constant vector and a runtime dict are DATA, not read here).
 *  Dict `literalForms` are the flat key/value form sequence; keyword keys are symbols the
 *  caller's symbol arm already treats as non-references. */
export function literalElements(v: unknown): readonly unknown[] | undefined {
  const kind = kindOf(v);
  if (kind === "vector" && (v as { evalElements?: boolean }).evalElements === true) {
    return (v as { __vector__: unknown[] }).__vector__;
  }
  if (kind === "dict") return (v as { literalForms?: readonly unknown[] }).literalForms;
  return undefined;
}

/** One binding of a binder form: its name and the forms after it — `[init]` for the let
 *  family, `[init, step?]` for `do`. */
export interface BindingEntry {
  readonly name: string;
  /** The binder's own symbol datum (for callers that key on it). */
  readonly symbol: unknown;
  readonly rest: readonly unknown[];
  /** The cons cells HOLDING each `rest` element (paren entries only; absent for bracket
   *  entries, which have no cells). A bare-name occurrence cut is keyed by its cell. */
  readonly cells?: readonly unknown[];
}

/**
 * Binding list of a let-family / `do` form, read the way `normalizeBindings` reads it: a
 * bracket whole-list `[a 1 b 2]` pairs elements up (let family only — `do` refuses it at
 * runtime); a paren list holds `(name init…)` pairs or bracket `[name init…]` entries.
 * `#(…)` and malformed entries yield nothing here — the evaluator doors them.
 */
export function bindingEntries(bindings: unknown, allowWholeList = true): BindingEntry[] {
  const out: BindingEntry[] = [];
  const entry = (name: unknown, rest: readonly unknown[], cells?: readonly unknown[]): void => {
    if (isSymbol(name))
      out.push({ name: symName(name), symbol: name, rest, ...(cells === undefined ? {} : { cells }) });
  };
  if (kindOf(bindings) === "vector") {
    if (!(bindings as { evalElements?: boolean }).evalElements || !allowWholeList) return out;
    const els = (bindings as { __vector__: unknown[] }).__vector__;
    for (let i = 0; i + 1 < els.length; i += 2) entry(els[i], [els[i + 1]]);
    return out;
  }
  for (const b of chain(bindings)) {
    if (kindOf(b) === "vector" && (b as { evalElements?: boolean }).evalElements === true) {
      const els = (b as { __vector__: unknown[] }).__vector__;
      entry(els[0], els.slice(1));
    } else if (isPair(b)) {
      const cells: unknown[] = [];
      for (let cur: unknown = b.cdr; isPair(cur); cur = cur.cdr) cells.push(cur);
      entry(b.car, chain(b.cdr), cells);
    }
  }
  return out;
}

/**
 * Clause (`cond` / `case` / `do` test clause) as its element list, read the way
 * `normalizeClause` reads it: a bracket clause `[test expr…]` is elementwise ≡ the paren
 * clause. `undefined` for a non-clause.
 */
export function clauseElements(clause: unknown): readonly unknown[] | undefined {
  if (isPair(clause)) return chain(clause);
  if (kindOf(clause) === "vector" && (clause as { evalElements?: boolean }).evalElements === true) {
    return (clause as { __vector__: unknown[] }).__vector__;
  }
  return undefined;
}
