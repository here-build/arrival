/**
 * Shared structural utilities for the LEGIBILITY pass (constitution §3.5's third
 * invention). All three legs (destructure, singularize, CSE) need the same three
 * primitives: a one-level "map children" reconstruction over `R`, an identity-based
 * deep substitution built on top of it, and a global bound-name census for
 * collision-safe minting.
 *
 * This is a FOURTH independent copy of the `R`-children shape — the walker's
 * `runtimeRefsOf`, ASYNC-IFY's `childrenOf`, and FRAME's `childrenOf`/`takenNamesOf`
 * are the other three, and each of those modules' own header notes the tension
 * explicitly ("candidates for extraction only when a fourth appears", frame.ts).
 * Landing legibility as its own fourth copy — not a shared extraction — is the
 * deliberate choice here too: the three existing passes evolved independently on
 * purpose, unifying them now would touch three files this mission has no reason to
 * open, and this package's own naming.ts already documents the same "adapt, don't
 * import" stance for copy-as-chunk material. Revisit if a fifth pass arrives.
 */
import type { Binding, CompilationUnit, Decl, Pattern, R, SlotId } from "../residual/types.js";

export type BlockR = Extract<R, { t: "Block" }>;

/** One-level structural reconstruction: apply `f` to every immediate `R` child,
 *  preserving `origin` and every non-child field via spread. Position-agnostic —
 *  statement-shaped and expression-shaped kinds share one function, because every
 *  legibility rewrite is a pure substitution, never position-sensitive the way
 *  ASYNC-IFY's await-insertion is. */
export function mapChildren(n: R, f: (child: R) => R): R {
  switch (n.t) {
    case "Ref":
    case "RuntimeRef":
    case "Lit":
    case "Continue":
      return n;
    case "Template":
      return { ...n, exprs: n.exprs.map(f) };
    case "Call":
    case "New":
      return { ...n, callee: f(n.callee), args: n.args.map(f) };
    case "Method":
      return { ...n, recv: f(n.recv), args: n.args.map(f) };
    case "Index":
      return { ...n, recv: f(n.recv), index: f(n.index) };
    case "Member":
      return { ...n, recv: f(n.recv) };
    case "Bin":
      return { ...n, left: f(n.left), right: f(n.right) };
    case "Un":
      return { ...n, arg: f(n.arg) };
    case "Cond":
      return { ...n, test: f(n.test), then: f(n.then), else: f(n.else) };
    case "Arrow":
      return { ...n, body: f(n.body) };
    case "ArrayLit":
      return { ...n, elements: n.elements.map(f) };
    case "ObjectLit":
      return { ...n, entries: n.entries.map((e) => ({ ...e, value: f(e.value) })) };
    case "Spread":
    case "Await":
    case "Throw":
      return { ...n, value: f(n.value) };
    case "Block":
      return mapBlockChildren(n, f);
    case "Const":
    case "Let":
      return { ...n, init: f(n.init) };
    case "Assign":
      return { ...n, value: f(n.value) };
    case "Return":
      return n.value === undefined ? n : { ...n, value: f(n.value) };
    case "While":
      return { ...n, test: f(n.test), body: mapBlockChildren(n.body, f) };
    case "ForOf":
      return { ...n, iterable: f(n.iterable), body: mapBlockChildren(n.body, f) };
    case "If":
      return {
        ...n,
        test: f(n.test),
        then: mapBlockChildren(n.then, f),
        else: n.else === undefined ? undefined : f(n.else),
      };
    case "Comment":
      return { ...n, node: f(n.node) };
    case "Annotated":
      return { ...n, value: f(n.value) };
    case "ChunkExpr":
    case "ChunkStmt": {
      // Slots are the fluid re-entry points (mercury-ir.md's mutual-recursion
      // rule — "never assume AST chunks are leaf nodes"): rebuild the map with
      // every value mapped, same keys; the verbatim `ast` stays opaque (blind
      // to the ts.Node tree, seeing to `slots` — exactly the memo's split).
      // This is what lets an occurrence rewrite (destructure substitution,
      // materializeImports' RuntimeRef→Ref commit, CSE's Ref swap) reach a
      // slot's fluid value exactly like any other child position.
      if (n.slots === undefined) return n;
      const slots = new Map<SlotId, R>();
      for (const [id, v] of n.slots) slots.set(id, f(v));
      return { ...n, slots };
    }
  }
}

export function mapBlockChildren(b: BlockR, f: (child: R) => R): BlockR {
  return { ...b, stmts: b.stmts.map(f) };
}

/** Read-only children — `mapChildren`'s visit-only sibling, for passes (destructure's
 *  occurrence analysis, CSE's candidate collection) that need to walk without
 *  reconstructing. */
export function childrenOf(node: R): readonly R[] {
  switch (node.t) {
    case "Ref":
    case "RuntimeRef":
    case "Lit":
    case "Continue":
      return [];
    case "Template":
      return node.exprs;
    case "Call":
    case "New":
      return [node.callee, ...node.args];
    case "Method":
      return [node.recv, ...node.args];
    case "Index":
      return [node.recv, node.index];
    case "Member":
      return [node.recv];
    case "Bin":
      return [node.left, node.right];
    case "Un":
      return [node.arg];
    case "Cond":
      return [node.test, node.then, node.else];
    case "Arrow":
      return [node.body];
    case "ArrayLit":
      return node.elements;
    case "ObjectLit":
      return node.entries.map((e) => e.value);
    case "Spread":
    case "Await":
    case "Throw":
      return [node.value];
    case "Block":
      return node.stmts;
    case "Const":
    case "Let":
      return [node.init];
    case "Assign":
      return [node.value];
    case "Return":
      return node.value === undefined ? [] : [node.value];
    case "While":
      return [node.test, node.body];
    case "ForOf":
      return [node.iterable, node.body];
    case "If":
      return node.else === undefined ? [node.test, node.then] : [node.test, node.then, node.else];
    case "Comment":
      return [node.node];
    case "Annotated":
      return [node.value];
    case "ChunkExpr":
    case "ChunkStmt":
      // The slot values — the fluid re-entry points (mercury-ir.md: "never
      // assume AST chunks are leaf nodes"); `ast` stays opaque — blind to the
      // ts.Node tree, seeing to `slots`, the memo's own split ("not by
      // walking, by indexing"). Every consumer needs this: the destructure
      // census counts a param occurrence living in a slot (missing it fires
      // destructure on outer occurrences while the slot keeps the undeclared
      // old name), CSE's candidate collection sees a slot's Call, and
      // collectBoundNames sees a slot's Refs.
      return node.slots === undefined ? [] : [...node.slots.values()];
  }
}

/** Deep, identity-keyed substitution: `replace(n)` may return a swap-in node (the
 *  original subtree is discarded, NOT recursed into further — the swap-in is
 *  assumed already-correct) or `undefined` to keep descending. Used by destructure
 *  and singularize to rewrite every occurrence of a specific binding without
 *  hand-rolling a bespoke walk per leg. */
export function substituteBy(n: R, replace: (n: R) => R | undefined): R {
  const direct = replace(n);
  if (direct !== undefined) return direct;
  return mapChildren(n, (child) => substituteBy(child, replace));
}

/** Every JS identifier text already spoken for anywhere in the unit — declaration
 *  AND reference positions. Mirrors FRAME's `takenNamesOf` (an independent copy,
 *  same reasoning: over-approximation is free, a skipped candidate only costs a
 *  `_2`). Computed once per leg, then threaded and MUTATED as that leg mints new
 *  names, so a single pass never mints the same text twice. */
export function collectBoundNames(unit: CompilationUnit): Set<string> {
  const out = new Set<string>();
  const pat = (p: Pattern): void => {
    if (p.t === "Binding") out.add(p.text);
    else if (p.t === "RestBinding") out.add(p.binding.text);
    else p.elements.forEach(pat);
  };
  const visit = (n: R): void => {
    switch (n.t) {
      case "Ref":
        out.add(n.binding.text);
        return;
      case "Arrow":
        for (const p of n.params) pat(p.pattern);
        visit(n.body);
        return;
      case "Const":
      case "Let":
      case "Assign":
        pat(n.pattern);
        visit(n.t === "Assign" ? n.value : n.init);
        return;
      case "ForOf":
        pat(n.pattern);
        visit(n.iterable);
        visit(n.body);
        return;
      default:
        for (const c of childrenOf(n)) visit(c);
    }
  };
  const visitDecl = (d: Decl): void => {
    switch (d.t) {
      case "FnDecl":
        out.add(d.name.text);
        for (const p of d.params) pat(p.pattern);
        visit(d.body);
        return;
      case "ConstDecl":
        out.add(d.name.text);
        visit(d.init);
        return;
      case "DeclComment":
        visitDecl(d.decl);
        return;
      case "Import":
      case "ImportType":
        for (const n of d.names) out.add(n.local ?? n.imported);
        return;
      case "Export":
        return;
    }
  };
  for (const d of unit.decls) visitDecl(d);
  for (const s of unit.body) visit(s);
  return out;
}

/** Mint a collision-free `__`-prefixed binding, matching the walker's own `fresh()`
 *  convention exactly (walk.ts's header: "`fresh()` mints `__`-prefixed glue names"
 *  — `cleanName` can never itself emit a leading underscore, so this can never
 *  collide with a user binding). Reserved for ENGINE-GLUE names (CSE temps) — the
 *  user-facing ladder (destructure ordinals, singularized element names) uses
 *  `mintReadable` below instead (SIGN-OFF.md's own bar: "no `__` glue leaking into
 *  user-facing positions"). */
export function mintFresh(hint: string, taken: Set<string>, cleanName: (s: string) => string): Binding {
  const base = `__${cleanName(hint)}`;
  let text = base;
  for (let n = 2; taken.has(text); n++) text = `${base}${n}`;
  taken.add(text);
  return { t: "Binding", text };
}

/** Mint a collision-free READABLE binding (no prefix, no cleaning — callers already
 *  pass a valid-identifier candidate: an ordinal name or a pluralize-derived,
 *  cleanName-passed element name). `_2`-suffixes on collision, matching the
 *  walker's own `declareJs` ladder tail exactly. */
export function mintReadable(name: string, taken: Set<string>): Binding {
  let text = name;
  for (let n = 2; taken.has(text); n++) text = `${name}_${n}`;
  taken.add(text);
  return { t: "Binding", text };
}
