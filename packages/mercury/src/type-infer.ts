/**
 * The type-analysis plane (design doc §3 "dictShapes" + §6 R2/R3) — run-view only.
 * Conservative DIRECT-FLOW inference over the desugared forest, feeding four
 * ts-base opinions:
 *
 *  - `types/explicit-signatures` — every top-level function gets explicit param +
 *    return types; the fallback where flow can't decide is honest `unknown`, never
 *    `any`, never a guessed shape.
 *  - `types/domain-interfaces` — a `(dict …)` shape whose accessors/constructions
 *    unify across ≥2 top-level function signatures materializes as a named
 *    `interface` (name derived from the flow: the param name that carries it,
 *    `candidate` → `Candidate`); single-boundary shapes stay structural inline.
 *  - `types/schema-zod` — an `s/*` schema tag (the contract-as-type-origin seam:
 *    emitted TYPES derive from DECLARED contracts) materializes as a named zod
 *    schema + `z.infer` alias, once per shape, shared by the infer call and the
 *    domain type.
 *  - `invariants/preconditions` — source semantics that imply an entry
 *    precondition (`max-by` / seedless folds over a possibly-empty parameter)
 *    surface as data for the lowerer's `invariant(…)` emission.
 *
 * The solver is a small monotone fixpoint: slots per binding, joins from usage
 * (a param used in arithmetic is a number) and from call flow (an argument's type
 * joins the callee's param slot). No unification variables, no HM — matching the
 * design's "conservative-direct-flow, fallback visible" ruling. Purity: reads the
 * forest, never mutates it; same forest → same rendered types (map iteration is
 * insertion order, which is source order).
 */
import pluralize from "pluralize";

import { cleanName } from "./names.js";
import { type Atom, head, isAtom, isKeyword, isList, keywordName, type ListNode, type Node } from "./nodes.js";

// ── the type lattice ─────────────────────────────────────────────────────────

export type Ty =
  | { k: "unknown" }
  | { k: "prim"; name: "number" | "string" | "boolean" }
  | { k: "lit"; value: string } // a string literal, kept only on the rvalue side
  | { k: "array"; el: Ty }
  | { k: "shape"; fields: Map<string, Ty> }
  | { k: "ref"; name: string } // a named alias (z.infer of an emitted schema)
  | { k: "union"; members: Ty[] };

const UNKNOWN: Ty = { k: "unknown" };
const NUM: Ty = { k: "prim", name: "number" };
const STR: Ty = { k: "prim", name: "string" };
const BOOL: Ty = { k: "prim", name: "boolean" };
const arrayOf = (el: Ty): Ty => ({ k: "array", el });

/** UTF-16 code-unit order — the repo's determinism law for emitted orderings
 *  ("comparator pinned to UTF-16 order, never localeCompare", lexical-js-naming). */
const cmpUtf16 = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Structural identity (field-order-insensitive) — join's equality check. */
function keyOf(t: Ty, depth = 0): string {
  if (depth > 4) return "unknown"; // cycle/depth guard
  switch (t.k) {
    case "unknown":
      return "unknown";
    case "prim":
      return t.name;
    case "lit":
      return JSON.stringify(t.value);
    case "array":
      return `array(${keyOf(t.el, depth + 1)})`;
    case "shape":
      return `shape{${[...t.fields]
        .map(([f, v]) => `${f}:${keyOf(v, depth + 1)}`)
        .toSorted(cmpUtf16)
        .join(";")}}`;
    case "ref":
      return `ref(${t.name})`;
    case "union":
      return `union(${t.members
        .map((m) => keyOf(m, depth + 1))
        .toSorted(cmpUtf16)
        .join("|")})`;
  }
}

/** The domain-interface census identity: a shape's FIELD-NAME set. Two shapes
 *  naming the same fields describe one record concept seen from two vantage
 *  points (an accessor demand vs a `(dict …)` construction) — the census joins
 *  their field types under one name rather than minting near-duplicates. */
const fieldSetKey = (t: Ty): string | null =>
  t.k === "shape" && t.fields.size > 0 ? [...t.fields.keys()].toSorted(cmpUtf16).join(",") : null;

/** Widen literals to their primitive — used on PARAM joins so a call-site literal
 *  never over-narrows a signature (`(best-of (list 3 1 4))` must not make
 *  `scores: (3 | 1 | 4)[]`); returns keep literals (the R2 string-literal-union
 *  clause applies to results, not demands). */
function widen(t: Ty): Ty {
  if (t.k === "lit") return STR;
  if (t.k === "array") return arrayOf(widen(t.el));
  if (t.k === "union") {
    const widened = t.members.map(widen);
    return widened.reduce(join, UNKNOWN);
  }
  return t;
}

function join(a: Ty, b: Ty): Ty {
  if (a.k === "unknown") return b;
  if (b.k === "unknown") return a;
  if (keyOf(a) === keyOf(b)) return a;
  if (a.k === "lit" && b.k === "lit") return { k: "union", members: [a, b] };
  if (a.k === "lit" && b.k === "prim" && b.name === "string") return STR;
  if (b.k === "lit" && a.k === "prim" && a.name === "string") return STR;
  if (a.k === "array" && b.k === "array") return arrayOf(join(a.el, b.el));
  if (a.k === "shape" && b.k === "shape") {
    // Fields ACCUMULATE (a demand seeing {scores} and a construction providing
    // {instruction, scores} describe one record from two vantage points).
    const fields = new Map(a.fields);
    for (const [f, v] of b.fields) fields.set(f, join(fields.get(f) ?? UNKNOWN, v));
    return { k: "shape", fields };
  }
  const flat = (t: Ty): Ty[] => (t.k === "union" ? t.members : [t]);
  const members: Ty[] = [];
  for (const m of [...flat(a), ...flat(b)]) {
    if (!members.some((x) => keyOf(x) === keyOf(m))) members.push(m);
  }
  // A union that would sprawl is not information — fall back to honest unknown.
  if (members.length > 4) return UNKNOWN;
  return members.length === 1 ? members[0]! : { k: "union", members };
}

// ── slots + program facts ────────────────────────────────────────────────────

interface Slot {
  ty: Ty;
}

interface FnLike {
  paramSlots: Slot[];
  retSlot: Slot;
  paramAtoms: Atom[];
}

type Binding = { slot: Slot } | { fn: FnLike };

/** An entry precondition implied by source semantics (R3): `param` must be a
 *  non-empty list for `form` to be defined. */
export interface Precondition {
  param: Atom;
  /** The source form that implies the check, for the message: `max-by`, `(apply -)`, … */
  form: string;
}

export interface TypeInfo {
  /** Rendered TS type for a binding atom (fn/lambda param, let var), or undefined
   *  when nothing beyond `unknown` is known. */
  typeOfBinding(atom: Atom): string | undefined;
  /** Rendered return type for a top-level define (keyed by its name atom) or a
   *  top-level define-bound lambda (keyed by the lambda node). */
  returnTypeOf(key: Atom | ListNode): string | undefined;
  /** The emitted zod-schema constant name for a quoted `s/*` tag node. */
  schemaConstOf(node: Node): string | undefined;
  /** Entry preconditions of a top-level define form (R3). */
  preconditionsOf(define: ListNode): readonly Precondition[];
  /** Emitted declarations, in order: zod schemas (+ `z.infer` aliases), then
   *  domain interfaces. */
  declarations: readonly string[];
  /** Whether any declaration needs `import { z } from "zod"`. */
  usesZod: boolean;
}

/** The infer-family verbs whose 3rd positional argument is a schema contract and
 *  whose result the interpreter wraps in a list (`inferList`). Shared with
 *  lower.ts / async-analysis.ts via these exports so the verb table has ONE home. */
export const INFER_VERBS = new Set(["infer", "infer/chat", "infer/agentic/end-to-end"]);

/** Is `n` a direct call to an infer-family verb? */
export const isInferCall = (n: Node | undefined): n is ListNode => {
  if (!isList(n)) return false;
  const h = n.list[0];
  return isAtom(h) && !h.str && INFER_VERBS.has(h.atom);
};

// ── s/* schema tags → zod + shape ────────────────────────────────────────────

/** The quoted datum of `(quote X)`, else undefined. */
const quotedDatum = (n: Node | undefined): Node | undefined =>
  isList(n) && head(n) === "quote" ? n.list[1] : undefined;

const sTagName = (n: Node | undefined): string | undefined =>
  isAtom(n) && !n.str && n.atom.startsWith("s/") ? n.atom : undefined;

/** Is this quoted datum an `s/*` schema tag (`s/string` atom or `(s/object …)` list)? */
function isSchemaTag(datum: Node | undefined): boolean {
  if (datum === undefined) return false;
  if (sTagName(datum) !== undefined) return true;
  return isList(datum) && sTagName(datum.list[0]) !== undefined;
}

const OPTIONAL = "/optional";
const stripOptional = (tag: string): { base: string; optional: boolean } =>
  tag.endsWith(OPTIONAL) ? { base: tag.slice(0, -OPTIONAL.length), optional: true } : { base: tag, optional: false };

const decodeStr = (a: Atom): string => a.atom; // schema strings carry no escapes in practice

/** A valid unquoted JS object key, else the quoted form. */
const objectKey = (name: string): string => (/^[A-Z_$][\w$]*$/i.test(name) ? name : JSON.stringify(name));

/** Lower an `s/*` tag datum to a zod expression + its structural type. Field keys
 *  keep their SOURCE spelling (wire fidelity: the schema names the JSON the model
 *  must return — a cleaned key would silently rename the wire). Anything outside
 *  the closed vocabulary is a door, never a guessed schema. */
function tagToZod(datum: Node): { zod: string; ty: Ty } {
  const name = sTagName(datum);
  if (name !== undefined) {
    const { base, optional } = stripOptional(name);
    const scalar: Record<string, { zod: string; ty: Ty }> = {
      "s/string": { zod: "z.string()", ty: STR },
      "s/number": { zod: "z.number()", ty: NUM },
      "s/boolean": { zod: "z.boolean()", ty: BOOL },
    };
    const hit = scalar[base];
    if (!hit)
      throw new Error(
        `types/schema-zod: unsupported schema tag \`${name}\` — expected s/string | s/number | s/boolean | (s/enum …) | (s/array …) | (s/object …)`,
      );
    return optional ? { zod: `${hit.zod}.optional()`, ty: hit.ty } : hit;
  }
  if (isList(datum)) {
    const h = sTagName(datum.list[0]);
    if (h !== undefined) {
      const { base, optional } = stripOptional(h);
      const wrap = (r: { zod: string; ty: Ty }): { zod: string; ty: Ty } =>
        optional ? { zod: `${r.zod}.optional()`, ty: r.ty } : r;
      switch (base) {
        case "s/enum": {
          const values = datum.list.slice(1);
          if (!values.every((v) => isAtom(v) && v.str)) {
            throw new Error(
              "types/schema-zod: (s/enum …) supports string values only — use (s/number)-typed fields for numeric domains",
            );
          }
          const lits = values.map((v) => decodeStr(v as Atom));
          return wrap({
            zod: `z.enum([${lits.map((s) => JSON.stringify(s)).join(", ")}])`,
            ty: { k: "union", members: lits.map((value) => ({ k: "lit", value }) as Ty) },
          });
        }
        case "s/array": {
          const el = datum.list[1];
          if (el === undefined) throw new Error("types/schema-zod: (s/array …) needs an element tag");
          const inner = tagToZod(el);
          return wrap({ zod: `z.array(${inner.zod})`, ty: arrayOf(inner.ty) });
        }
        case "s/object": {
          const fields: string[] = [];
          const shape = new Map<string, Ty>();
          const rest = datum.list.slice(1);
          for (let i = 0; i + 1 < rest.length; i += 2) {
            const k = rest[i]!;
            if (!isKeyword(k)) throw new Error("types/schema-zod: (s/object …) expects :keyword field names");
            const field = keywordName(k);
            const v = tagToZod(rest[i + 1]!);
            fields.push(`${objectKey(field)}: ${v.zod}`);
            shape.set(field, v.ty);
          }
          return wrap({ zod: `z.object({ ${fields.join(", ")} })`, ty: { k: "shape", fields: shape } });
        }
        default:
          throw new Error(`types/schema-zod: unsupported schema tag \`${h}\``);
      }
    }
  }
  throw new Error("types/schema-zod: malformed s/* schema tag");
}

// ── preconditions (R3) — a pure scan, independent of the solver ──────────────

/** Seedless folds: `(apply op xs)` forms with no identity element — defined only
 *  on a non-empty list. (`+`/`*` have identities and need no check.) */
const SEEDLESS_APPLY = new Set(["-", "/", "max", "min"]);

/** Entry preconditions of a define: `max-by` / seedless `apply` applied DIRECTLY
 *  to a parameter of this function (direct flow only — a computed list is the
 *  callee's own concern). */
export function entryPreconditions(define: ListNode): Precondition[] {
  const sig = define.list[1];
  if (!isList(sig)) return [];
  const params = new Map<string, Atom>();
  for (const p of sig.list.slice(1)) if (isAtom(p) && p.atom !== ".") params.set(p.atom, p);
  const out: Precondition[] = [];
  const seen = new Set<string>();
  const record = (arg: Node | undefined, form: string): void => {
    if (isAtom(arg) && !arg.str && params.has(arg.atom) && !seen.has(arg.atom)) {
      seen.add(arg.atom);
      out.push({ param: params.get(arg.atom)!, form });
    }
  };
  const walk = (n: Node): void => {
    if (!isList(n)) return;
    const h = head(n);
    if (h === "max-by" || h === "min-by") record(n.list[2], h);
    if (h === "apply" && isAtom(n.list[1]) && !n.list[1].str && SEEDLESS_APPLY.has(n.list[1].atom)) {
      record(n.list[2], `apply ${n.list[1].atom}`);
    }
    // Do not descend into nested lambdas/defines: the check guards THIS entry.
    if (h === "lambda" || h === "define") return;
    for (const c of n.list) walk(c);
  };
  for (const form of define.list.slice(2)) walk(form);
  return out;
}

// ── the solver ───────────────────────────────────────────────────────────────

const pascal = (name: string): string => (name === "" ? name : name.charAt(0).toUpperCase() + name.slice(1));

/** Builtins with fixed operand/result typing (the subset of stdlib the solver
 *  understands; everything else contributes no constraint). */
const NUMERIC_OPS = new Set(["+", "-", "*", "/", "modulo", "remainder", "quotient", "min", "max"]);
const NUMERIC_COMPARE = new Set(["<", ">", "<=", ">=", "="]);
const BOOL_RESULT = new Set([
  "eq?",
  "eqv?",
  "equal?",
  "string=?",
  "string-ci=?",
  "zero?",
  "even?",
  "odd?",
  "not",
  "null?",
  "empty?",
]);

export function inferTypes(forest: Node[]): TypeInfo {
  // Every binding atom → its slot (params, lambda params, let vars). Insertion
  // order is walk order is source order — determinism by construction.
  const bindingSlots = new Map<Atom, Slot>();
  const slotFor = (a: Atom, init: Ty = UNKNOWN): Slot => {
    let s = bindingSlots.get(a);
    if (!s) {
      s = { ty: init };
      bindingSlots.set(a, s);
    }
    return s;
  };
  const lambdaFns = new Map<ListNode, FnLike>();
  const retSlots = new Map<Atom | ListNode, Slot>();
  const preconds = new Map<ListNode, Precondition[]>();

  // schema registry: canonical tag key → { name, zod, ty }
  const schemas = new Map<string, { name: string; zod: string; ty: Ty }>();
  const schemaNames = new Set<string>();
  const schemaByNode = new Map<Node, string>();
  const refShapes = new Map<string, Ty>();

  let changed = false;
  const assign = (slot: Slot, ty: Ty): void => {
    const next = join(slot.ty, ty);
    if (keyOf(next) !== keyOf(slot.ty)) {
      slot.ty = next;
      changed = true;
    }
  };

  // ── top-level registration ──
  const topFns = new Map<string, FnLike>(); // scheme name → fn
  const topVals = new Map<string, Slot>(); // scheme name → value slot
  const fnDefines: { name: string; fn: FnLike; body: Node[]; define: ListNode }[] = [];
  const valDefines: { slot: Slot; rhs: Node | undefined }[] = [];
  const topLambdas: { name: string; fn: FnLike; node: ListNode }[] = [];

  const paramAtomsOf = (list: Node[] | undefined): { atom: Atom; rest: boolean }[] => {
    if (!list) return [];
    const out: { atom: Atom; rest: boolean }[] = [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i]!;
      if (isAtom(p) && p.atom === ".") {
        const rest = list[i + 1];
        if (isAtom(rest)) out.push({ atom: rest, rest: true });
        break;
      }
      if (isAtom(p)) out.push({ atom: p, rest: false });
    }
    return out;
  };

  const makeFn = (params: { atom: Atom; rest: boolean }[], retKey: Atom | ListNode): FnLike => {
    const paramSlots = params.map((p) => slotFor(p.atom, p.rest ? arrayOf(UNKNOWN) : UNKNOWN));
    const retSlot: Slot = { ty: UNKNOWN };
    retSlots.set(retKey, retSlot);
    return { paramSlots, retSlot, paramAtoms: params.map((p) => p.atom) };
  };

  for (const form of forest) {
    if (!isList(form) || head(form) !== "define") continue;
    const sig = form.list[1];
    if (isList(sig) && isAtom(sig.list[0])) {
      const fn = makeFn(paramAtomsOf(sig.list.slice(1)), sig.list[0]);
      topFns.set(sig.list[0].atom, fn);
      fnDefines.push({ name: sig.list[0].atom, fn, body: form.list.slice(2), define: form });
      preconds.set(form, entryPreconditions(form));
    } else if (isAtom(sig)) {
      const rhs = form.list[2];
      if (isList(rhs) && head(rhs) === "lambda") {
        const fn = makeFn(paramAtomsOf(isList(rhs.list[1]) ? rhs.list[1].list : undefined), rhs);
        lambdaFns.set(rhs, fn);
        topFns.set(sig.atom, fn);
        retSlots.set(sig, fn.retSlot); // the define name aliases the lambda's return
        topLambdas.push({ name: sig.atom, fn, node: rhs });
      } else {
        const slot = slotFor(sig);
        topVals.set(sig.atom, slot);
        valDefines.push({ slot, rhs });
      }
    }
  }

  // ── schema registration (name needs the enclosing define — tracked in walk) ──
  let currentDefine = "";
  const registerSchema = (quoteNode: Node, datum: Node): Ty => {
    const key = JSON.stringify(datumKey(datum));
    let entry = schemas.get(key);
    if (!entry) {
      const { zod, ty } = tagToZod(datum);
      let name = `${pascal(cleanName(currentDefine || "inferred"))}Result`;
      let n = 2;
      while (schemaNames.has(name)) name = `${pascal(cleanName(currentDefine || "inferred"))}Result${n++}`;
      schemaNames.add(name);
      entry = { name, zod, ty };
      schemas.set(key, entry);
      refShapes.set(name, ty);
    }
    schemaByNode.set(quoteNode, `${entry.name}Schema`);
    return { k: "ref", name: entry.name };
  };

  // ── the walk ──
  type Env = Map<string, Binding>[];
  const lookup = (env: Env, name: string): Binding | undefined => {
    for (let i = env.length - 1; i >= 0; i--) {
      const hit = env[i]!.get(name);
      if (hit) return hit;
    }
    if (topFns.has(name)) return { fn: topFns.get(name)! };
    if (topVals.has(name)) return { slot: topVals.get(name)! };
    return undefined;
  };

  const demand = (n: Node | undefined, ty: Ty, env: Env): void => {
    if (isAtom(n) && !n.str) {
      const b = lookup(env, n.atom);
      if (b && "slot" in b) assign(b.slot, widen(ty));
    }
  };

  /** The FnLike a node denotes when used as a function argument (a lambda literal
   *  or a reference to a known function), else undefined. */
  const fnOf = (n: Node | undefined, env: Env): FnLike | undefined => {
    if (isList(n) && head(n) === "lambda") {
      let fn = lambdaFns.get(n);
      if (!fn) {
        fn = makeFn(paramAtomsOf(isList(n.list[1]) ? n.list[1].list : undefined), n);
        lambdaFns.set(n, fn);
      }
      return fn;
    }
    if (isAtom(n) && !n.str) {
      const b = lookup(env, n.atom);
      if (b && "fn" in b) return b.fn;
    }
    return undefined;
  };

  const elementOf = (t: Ty): Ty => (t.k === "array" ? t.el : UNKNOWN);
  const fieldOf = (t: Ty, field: string): Ty => {
    const resolved = t.k === "ref" ? (refShapes.get(t.name) ?? UNKNOWN) : t;
    return resolved.k === "shape" ? (resolved.fields.get(field) ?? UNKNOWN) : UNKNOWN;
  };

  /** Walk a lambda's body against its slots and return its (current) result type. */
  const walkFnBody = (fn: FnLike, body: Node[], env: Env): Ty => {
    const frame = new Map<string, Binding>();
    for (const [i, a] of fn.paramAtoms.entries()) frame.set(a.atom, { slot: fn.paramSlots[i]! });
    const ty = walkBody(body, [...env, frame]);
    assign(fn.retSlot, ty);
    return fn.retSlot.ty;
  };

  const walkBody = (forms: Node[], env: Env): Ty => {
    // letrec*-ish: internal defines pre-register in this frame.
    const frame = new Map<string, Binding>();
    const inner = [...env, frame];
    for (const f of forms) {
      if (isList(f) && head(f) === "define") {
        const sig = f.list[1];
        if (isList(sig) && isAtom(sig.list[0])) {
          const fn = makeFn(paramAtomsOf(sig.list.slice(1)), sig.list[0]);
          frame.set(sig.list[0].atom, { fn });
        } else if (isAtom(sig)) {
          frame.set(sig.atom, { slot: slotFor(sig) });
        }
      }
    }
    let last: Ty = UNKNOWN;
    for (const f of forms) {
      if (isList(f) && head(f) === "define") {
        const sig = f.list[1];
        if (isList(sig) && isAtom(sig.list[0])) {
          const b = frame.get(sig.list[0].atom);
          if (b && "fn" in b) walkFnBody(b.fn, f.list.slice(2), inner);
        } else if (isAtom(sig)) {
          const b = frame.get(sig.atom);
          if (b && "slot" in b) assign(b.slot, infer(f.list[2], inner));
        }
        last = UNKNOWN;
        continue;
      }
      last = infer(f, inner);
    }
    return last;
  };

  const litTy = (a: Atom): Ty | undefined => {
    if (a.str) return { k: "lit", value: a.atom };
    if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(a.atom)) return NUM;
    if (a.atom === "#t" || a.atom === "#f") return BOOL;
    return undefined;
  };

  const quoteTy = (datum: Node | undefined): Ty => {
    if (datum === undefined) return UNKNOWN;
    if (isAtom(datum)) return litTy(datum) ?? STR; // quoted symbol → string
    if (isList(datum)) return arrayOf(datum.list.map(quoteTy).reduce(join, UNKNOWN));
    return UNKNOWN;
  };

  function infer(n: Node | undefined, env: Env): Ty {
    if (n === undefined) return UNKNOWN;
    if (isAtom(n)) {
      const lit = litTy(n);
      if (lit) return lit;
      const b = lookup(env, n.atom);
      if (b) return "slot" in b ? b.slot.ty : UNKNOWN; // a fn used as a value: no fn rendering, honest unknown
      return UNKNOWN;
    }
    if (!isList(n) || n.list.length === 0) return arrayOf(UNKNOWN);
    const h = n.list[0];

    if (isKeyword(h)) {
      const obj = n.list[1];
      const field = keywordName(h);
      const t = infer(obj, env);
      demand(obj, { k: "shape", fields: new Map([[field, UNKNOWN]]) }, env);
      return fieldOf(t, field);
    }

    const hn = isAtom(h) && !h.str ? h.atom : undefined;
    if (hn !== undefined) {
      switch (hn) {
        case "quote":
          return quoteTy(n.list[1]);
        case "lambda": {
          const fn = fnOf(n, env)!;
          walkFnBody(fn, n.list.slice(2), env);
          return UNKNOWN; // fn values render as unknown when they escape
        }
        case "if": {
          infer(n.list[1], env);
          return join(infer(n.list[2], env), n.list[3] === undefined ? UNKNOWN : infer(n.list[3], env));
        }
        case "begin":
          return walkBody(n.list.slice(1), env);
        case "let":
        case "let*": {
          const named = isAtom(n.list[1]);
          const bindings = named ? n.list[2] : n.list[1];
          const bodyForms = n.list.slice(named ? 3 : 2);
          const frame = new Map<string, Binding>();
          const loopFn: FnLike | undefined = named
            ? { paramSlots: [], retSlot: { ty: UNKNOWN }, paramAtoms: [] }
            : undefined;
          if (isList(bindings)) {
            for (const b of bindings.list) {
              if (isList(b) && isAtom(b.list[0])) {
                const slot = slotFor(b.list[0]);
                assign(slot, widen(infer(b.list[1], env)));
                frame.set(b.list[0].atom, { slot });
                if (loopFn) {
                  loopFn.paramSlots.push(slot);
                  loopFn.paramAtoms.push(b.list[0]);
                }
              }
            }
          }
          if (named && loopFn) {
            retSlots.set(n, loopFn.retSlot);
            frame.set((n.list[1] as Atom).atom, { fn: loopFn });
            const ty = walkBody(bodyForms, [...env, frame]);
            assign(loopFn.retSlot, ty);
            return loopFn.retSlot.ty;
          }
          return walkBody(bodyForms, [...env, frame]);
        }
        case "require":
          return UNKNOWN;
      }

      // infer-family verbs — the contract-as-type-origin seam.
      if (INFER_VERBS.has(hn)) {
        demand(n.list[1], STR, env); // model alias
        if (hn === "infer") demand(n.list[2], STR, env); // prompt is a string
        infer(n.list[1], env);
        infer(n.list[2], env);
        const schemaArg = n.list[3];
        if (schemaArg !== undefined) {
          const datum = quotedDatum(schemaArg);
          if (datum !== undefined && isSchemaTag(datum)) {
            return arrayOf(registerSchema(schemaArg, datum)); // pre-fold: a one-element list
          }
          infer(schemaArg, env);
          return arrayOf(UNKNOWN);
        }
        return arrayOf(STR); // unschema'd infer yields text
      }
      if (hn === "infer/chat/system" || hn === "infer/chat/user" || hn === "infer/chat/assistant") {
        demand(n.list[1], STR, env);
        infer(n.list[1], env);
        return arrayOf(STR); // the (role content) tuple
      }

      // builtins with fixed typing
      if (NUMERIC_OPS.has(hn)) {
        for (const a of n.list.slice(1)) {
          demand(a, NUM, env);
          infer(a, env);
        }
        return NUM;
      }
      if (NUMERIC_COMPARE.has(hn)) {
        // Scheme's `<`/`>`/`<=`/`>=`/`=` are numeric (string comparison is the
        // `string=?` family) — the operands are a number demand, like arithmetic.
        for (const a of n.list.slice(1)) {
          demand(a, NUM, env);
          infer(a, env);
        }
        return BOOL;
      }
      if (BOOL_RESULT.has(hn)) {
        for (const a of n.list.slice(1)) {
          if (hn === "zero?" || hn === "even?" || hn === "odd?") demand(a, NUM, env);
          if (hn === "null?" || hn === "empty?") demand(a, arrayOf(UNKNOWN), env);
          if (hn === "string=?" || hn === "string-ci=?") demand(a, STR, env);
          infer(a, env);
        }
        return BOOL;
      }
      if (hn === "and" || hn === "or") {
        let t: Ty = UNKNOWN;
        for (const a of n.list.slice(1)) t = join(t, infer(a, env));
        return t;
      }
      if (hn === "string-append") {
        for (const a of n.list.slice(1)) {
          demand(a, STR, env);
          infer(a, env);
        }
        return STR;
      }
      if (hn === "length") {
        demand(n.list[1], arrayOf(UNKNOWN), env);
        infer(n.list[1], env);
        return NUM;
      }
      if (hn === "list")
        return arrayOf(
          n.list
            .slice(1)
            .map((a) => infer(a, env))
            .reduce(join, UNKNOWN),
        );
      if (hn === "cons") {
        const headTy = infer(n.list[1], env);
        const tail = infer(n.list[2], env);
        return join(arrayOf(headTy), tail);
      }
      if (hn === "append")
        return n.list
          .slice(1)
          .map((a) => infer(a, env))
          .reduce(join, UNKNOWN);
      if (hn === "reverse") return infer(n.list[1], env);
      if (hn === "car" || hn === "first") {
        const t = infer(n.list[1], env);
        demand(n.list[1], arrayOf(UNKNOWN), env);
        return elementOf(t);
      }
      if (hn === "cdr") return infer(n.list[1], env);
      if (hn === "list-ref") {
        const t = infer(n.list[1], env);
        infer(n.list[2], env);
        return elementOf(t);
      }
      if (hn === "map" || hn === "filter" || hn === "every" || hn === "some") {
        const [fnArg, ...lists] = n.list.slice(1);
        const listTys = lists.map((l) => infer(l, env));
        for (const l of lists) demand(l, arrayOf(UNKNOWN), env); // traversal implies a list even when fn is opaque
        const fn = fnOf(fnArg, env);
        if (fn) {
          if (isList(fnArg) && head(fnArg) === "lambda") walkFnBody(fn, fnArg.list.slice(2), env);
          for (const [i, t] of listTys.entries()) {
            if (fn.paramSlots[i]) assign(fn.paramSlots[i]!, widen(elementOf(t)));
          }
          for (const [i, l] of lists.entries()) {
            const p = fn.paramSlots[i];
            if (p) demand(l, arrayOf(p.ty), env);
          }
          if (hn === "map") return arrayOf(fn.retSlot.ty);
        } else if (isKeyword(fnArg)) {
          const field = keywordName(fnArg);
          if (hn === "map") return arrayOf(fieldOf(elementOf(listTys[0] ?? UNKNOWN), field));
        }
        if (hn === "filter") return listTys[0] ?? arrayOf(UNKNOWN);
        if (hn === "map") return arrayOf(UNKNOWN);
        return BOOL;
      }
      if (hn === "apply") {
        const op = n.list[1];
        const listTy = infer(n.list[2], env);
        if (isAtom(op) && !op.str) {
          if (NUMERIC_OPS.has(op.atom)) {
            demand(n.list[2], arrayOf(NUM), env);
            return NUM;
          }
          if (op.atom === "append") return elementOf(listTy);
        }
        const fn = fnOf(op, env);
        if (fn) return fn.retSlot.ty;
        return UNKNOWN;
      }
      if (hn === "max-by" || hn === "min-by") {
        const fn = fnOf(n.list[1], env);
        const listTy = infer(n.list[2], env);
        const el = elementOf(listTy);
        if (fn) {
          if (isList(n.list[1]) && head(n.list[1]) === "lambda")
            walkFnBody(fn, (n.list[1] as ListNode).list.slice(2), env);
          if (fn.paramSlots[0]) assign(fn.paramSlots[0]!, widen(el));
        }
        return el;
      }
      if (hn === "dict") {
        const fields = new Map<string, Ty>();
        const rest = n.list.slice(1);
        for (let i = 0; i + 1 < rest.length; i += 2) {
          const k = rest[i]!;
          if (isKeyword(k)) fields.set(cleanName(keywordName(k)), infer(rest[i + 1], env));
          else infer(rest[i + 1], env);
        }
        return { k: "shape", fields };
      }

      // a call to a known function (top-level, internal, loop, or fn-valued param)
      const b = lookup(env, hn);
      if (b && "fn" in b) {
        applyCall(b.fn, n.list.slice(1), env);
        return b.fn.retSlot.ty;
      }
    }

    // an immediate lambda call `((lambda (it) …) 3)` — desugared compose/pipe in
    // call position lands here; the args type the params directly.
    if (isList(h)) {
      const fn = fnOf(h, env);
      if (fn) {
        if (head(h) === "lambda") walkFnBody(fn, h.list.slice(2), env);
        applyCall(fn, n.list.slice(1), env);
        return fn.retSlot.ty;
      }
    }

    // unknown call / structure: walk children for their own constraints
    for (const c of n.list) infer(c, env);
    return UNKNOWN;
  }

  /** Flow a call both ways: argument types join the callee's param slots, and a
   *  param slot's (current) type flows back into an identifier argument — the
   *  edge that types `it` in `((lambda (it) (double it)) 3)` and a caller's local
   *  passed into a typed signature. */
  function applyCall(fn: FnLike, args: Node[], env: Env): void {
    for (const [i, a] of args.entries()) {
      const t = infer(a, env);
      const p = fn.paramSlots[i];
      if (p) {
        assign(p, widen(t));
        demand(a, p.ty, env);
      }
    }
  }

  /** Canonical serialization of a quoted datum, for schema dedup. */
  function datumKey(d: Node): unknown {
    if (isAtom(d)) return d.str ? { s: d.atom } : d.atom;
    if (isList(d)) return d.list.map(datumKey);
    return null;
  }

  // ── fixpoint ──
  for (let pass = 0; pass < 10; pass++) {
    changed = false;
    for (const { slot, rhs } of valDefines) if (rhs) assign(slot, widen(infer(rhs, [])));
    for (const d of fnDefines) {
      currentDefine = d.name;
      walkFnBody(d.fn, d.body, []);
    }
    for (const l of topLambdas) {
      currentDefine = l.name;
      walkFnBody(l.fn, l.node.list.slice(2), []);
    }
    currentDefine = "";
    for (const form of forest) {
      if (!isList(form) || head(form) !== "define") infer(form, []);
    }
    if (!changed) break;
  }

  // ── domain-interface census (types/domain-interfaces) ──
  // A shape (identified by its FIELD-NAME set) is named when it appears in ≥2
  // top-level function signatures. Its interface carries the JOIN of every
  // sighting's field types; its name derives from the flow — the param name
  // that carries it (weight 10; an array carrier votes its singular:
  // `candidates` → `candidate`), falling back to the producing function
  // (`assess` → `AssessResult`, weight 1).
  const shapeSites = new Map<string, { ty: Ty; fns: Set<string>; votes: Map<string, number> }>();
  const noteShape = (t: Ty, fnName: string, carrier: string | undefined): void => {
    const resolved = t.k === "array" ? t.el : t;
    const key = fieldSetKey(resolved);
    if (key === null || resolved.k !== "shape") return;
    let site = shapeSites.get(key);
    if (!site) {
      site = { ty: resolved, fns: new Set(), votes: new Map() };
      shapeSites.set(key, site);
    }
    site.ty = join(site.ty, resolved);
    site.fns.add(fnName);
    const vote = (name: string, weight: number): void =>
      void site.votes.set(name, (site.votes.get(name) ?? 0) + weight);
    if (carrier === undefined) {
      vote(`${fnName}Result`, 1); // return position: the producer names it, weakly
    } else if (t.k === "shape") {
      vote(carrier, 10);
    } else {
      const singular = pluralize.singular(carrier);
      if (singular && singular !== carrier) vote(singular, 10); // candidates: Candidate[]
    }
  };
  for (const d of fnDefines) {
    for (const [i, a] of d.fn.paramAtoms.entries()) noteShape(d.fn.paramSlots[i]!.ty, d.name, cleanName(a.atom));
    noteShape(d.fn.retSlot.ty, d.name, undefined);
  }

  // Names that would shadow a TS built-in/global utility type are never minted —
  // `interface Record { … }` silently hijacks `Record<K, V>` for the whole module.
  const RESERVED_TYPE_NAMES = new Set([
    "Array",
    "Boolean",
    "Date",
    "Error",
    "Function",
    "Map",
    "Number",
    "Object",
    "Omit",
    "Partial",
    "Pick",
    "Promise",
    "Readonly",
    "Record",
    "RegExp",
    "Required",
    "Set",
    "String",
    "Symbol",
  ]);
  const namedShapes = new Map<string, { name: string; ty: Ty }>(); // field-set key → interface
  const takenTypeNames = new Set(schemaNames);
  for (const [key, site] of shapeSites) {
    if (site.fns.size < 2) continue;
    const best = [...site.votes.entries()].toSorted((a, b) => b[1] - a[1] || cmpUtf16(a[0], b[0]))[0]?.[0] ?? "record";
    let base = pascal(cleanName(best));
    if (base === "" || base === "_") base = "Shape";
    if (RESERVED_TYPE_NAMES.has(base)) base = `${base}Shape`;
    let name = base;
    let n = 2;
    while (takenTypeNames.has(name)) name = `${base}${n++}`;
    takenTypeNames.add(name);
    namedShapes.set(key, { name, ty: site.ty });
  }

  // ── rendering ──
  function render(t: Ty, depth = 0, skipNamed = false): string {
    if (depth > 4) return "unknown";
    switch (t.k) {
      case "unknown":
        return "unknown";
      case "prim":
        return t.name;
      case "lit":
        return JSON.stringify(t.value);
      case "array": {
        const el = render(t.el, depth + 1);
        return t.el.k === "union" ? `(${el})[]` : `${el}[]`;
      }
      case "ref":
        return t.name;
      case "shape": {
        if (!skipNamed) {
          const key = fieldSetKey(t);
          const named = key === null ? undefined : namedShapes.get(key);
          if (named !== undefined) return named.name;
        }
        const fields = [...t.fields].map(([f, v]) => `${objectKey(f)}: ${render(v, depth + 1)}`);
        return `{ ${fields.join("; ")} }`;
      }
      case "union": {
        const rank = (m: Ty): string => {
          const order: Record<string, number> = { number: 0, string: 1, boolean: 2 };
          const r = render(m, depth + 1);
          const bucket = order[r] ?? (m.k === "lit" ? 3 : 4);
          return `${bucket}:${r}`;
        };
        return [...t.members]
          .toSorted((a, b) => cmpUtf16(rank(a), rank(b)))
          .map((m) => render(m, depth + 1))
          .join(" | ");
      }
    }
  }

  // ── declarations, in emission order: schemas (+ aliases), then interfaces ──
  const declarations: string[] = [];
  for (const { name, zod } of schemas.values()) {
    declarations.push(`const ${name}Schema = ${zod};\ntype ${name} = z.infer<typeof ${name}Schema>;`);
  }
  for (const { name, ty } of namedShapes.values()) {
    if (ty.k !== "shape") continue;
    const fields = [...ty.fields].map(([f, v]) => `${objectKey(f)}: ${render(v, 1)};`).join(" ");
    declarations.push(`interface ${name} { ${fields} }`);
  }

  const rendered = (t: Ty): string | undefined => {
    if (t.k === "unknown") return undefined;
    return render(t);
  };

  return {
    typeOfBinding: (atom) => {
      const slot = bindingSlots.get(atom);
      return slot ? rendered(slot.ty) : undefined;
    },
    returnTypeOf: (key) => {
      const slot = retSlots.get(key);
      return slot ? rendered(slot.ty) : undefined;
    },
    schemaConstOf: (node) => schemaByNode.get(node),
    preconditionsOf: (define) => preconds.get(define) ?? [],
    declarations,
    usesZod: schemas.size > 0,
  };
}
