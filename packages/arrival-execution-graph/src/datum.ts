/**
 * Reading arrival data — forms and runtime values alike — on the authoritative `kind` tag (like
 * arrival's slice.ts), without importing its classes. The one copy the plan, dataflow, capture,
 * progress and render-graph layers share.
 */

export type DuckPair = { readonly car: unknown; readonly cdr: unknown };
export type DuckSymbol = { readonly __name__: string | symbol };

export const kindOf = (v: unknown): string | undefined =>
  v !== null && typeof v === "object" ? (v as { kind?: string }).kind : undefined;
export const isPair = (v: unknown): v is DuckPair => kindOf(v) === "pair";
export const isSymbol = (v: unknown): v is DuckSymbol => kindOf(v) === "symbol";

/** A symbol's name; `undefined` for anything else (or a gensym without a description). */
export function symbolName(v: unknown): string | undefined {
  if (!isSymbol(v)) return undefined;
  return typeof v.__name__ === "string" ? v.__name__ : v.__name__.description;
}

/** A known symbol's name; a gensym without a description prints as its JS symbol. */
export const symName = (s: DuckSymbol): string => symbolName(s) ?? String(s.__name__);
export const nameIs = (v: unknown, name: string): boolean => isSymbol(v) && symName(v) === name;
export const isKeyword = (v: unknown): boolean => isSymbol(v) && /^:./.test(symName(v));

/** Operand forms as step slots: `arg<k>` positionally, `:kw` for the operand after a keyword
 *  (`(f :k v)` is two operands, one slot). `at` is the index of the slot's value operand. */
export function operandSlots(forms: readonly unknown[]): { slot: string; at: number }[] {
  const out: { slot: string; at: number }[] = [];
  let k = 0;
  for (let i = 0; i < forms.length; i++) {
    const form = forms[i];
    if (isKeyword(form) && i + 1 < forms.length) out.push({ slot: symName(form as DuckSymbol), at: ++i });
    else out.push({ slot: `arg${k++}`, at: i });
  }
  return out;
}

/** The elements of a list; a dotted tail is ignored. */
export function listItems(list: unknown): unknown[] {
  const out: unknown[] = [];
  for (let c = list; isPair(c); c = c.cdr) out.push(c.car);
  return out;
}

/** The forms after the head of a call form. */
export const operandForms = (node: unknown): unknown[] => (isPair(node) ? listItems(node.cdr) : []);

/** Length of a proper list value; `undefined` for anything else. */
export function listLength(v: unknown): number | undefined {
  let n = 0;
  let cur = v;
  for (; isPair(cur); cur = cur.cdr) n++;
  return kindOf(cur) === "nil" ? n : undefined;
}

/** Symbol names in a form outside `quote` — through `[…]`/`#(…)` vectors and `{…}` literals,
 *  which arrival's `referencedSymbols` does not enter. An over-approximation of the free
 *  variables (inner binders are not subtracted). */
export function symbolsIn(form: unknown, out = new Set<string>(), skip?: ReadonlySet<unknown>): Set<string> {
  if (skip?.has(form)) return out;
  const name = symbolName(form);
  if (name !== undefined) out.add(name);
  else if (isPair(form)) {
    if (nameIs(form.car, "quote")) return out;
    let c: unknown = form;
    for (; isPair(c); c = c.cdr) symbolsIn(c.car, out, skip);
    symbolsIn(c, out, skip);
  } else if (kindOf(form) === "vector")
    for (const el of (form as { __vector__: unknown[] }).__vector__) symbolsIn(el, out, skip);
  else if (kindOf(form) === "dict")
    for (const el of (form as { literalForms?: unknown[] }).literalForms ?? []) symbolsIn(el, out, skip);
  return out;
}

/** A `[…]` reader literal: an evaluated vector (bracket bindings, bracket clauses). */
export function bracketItems(v: unknown): unknown[] | undefined {
  if (kindOf(v) !== "vector") return undefined;
  const vec = v as { __vector__: unknown[]; evalElements?: boolean };
  return vec.evalElements === true ? vec.__vector__ : undefined;
}

/** A list's or a `[…]` literal's elements. */
export const elements = (list: unknown): unknown[] => bracketItems(list) ?? listItems(list);

export interface Binding {
  readonly name: string;
  readonly init: unknown;
  readonly hasInit: boolean;
}

/** `((a 1) (b 2))`, `([a 1])`, or the bracket form `[a 1 b 2]`. */
export function bindingsOf(list: unknown): Binding[] {
  const flat = bracketItems(list);
  if (flat) {
    const out: Binding[] = [];
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const name = flat[i];
      if (isSymbol(name)) out.push({ name: symName(name), init: flat[i + 1], hasInit: true });
    }
    return out;
  }
  return listItems(list).flatMap((form): Binding[] => {
    if (isSymbol(form)) return [{ name: symName(form), init: undefined, hasInit: false }];
    const parts = elements(form);
    if (parts.length === 0 || !isSymbol(parts[0])) return [];
    return [{ name: symName(parts[0]), init: parts[1], hasInit: parts.length > 1 }];
  });
}
