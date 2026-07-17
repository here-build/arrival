/**
 * MATERIALIZE — commits a `NameAllocation` onto the provisional
 * `CompilationUnit` walk() built: (a) renames every non-destructured Binding
 * IN PLACE (mutating `.text` — safe, and the only practical option: Binding
 * objects are shared by reference at every occurrence site). Nothing
 * downstream of THIS mutation depends on the PROVISIONAL (pre-mutation) text
 * — the three passes that run later each decide by something else, or by
 * text that's already final by the time they run:
 *   - `../naming/shared-bindings.ts`'s CSE (`sharedBindingsOf`) DOES decide
 *     by text (`structuralKey`'s JSON-stringify includes a `Ref`'s bound
 *     name) — sound only because it runs AFTER this materializer, over the
 *     already-final tree (that module's own header: "structural equality BY
 *     TEXT… is only sound once names are collision-resolved and final").
 *   - `../naming/asyncness.ts`'s `materializeAsyncness` and
 *     `../naming/imports.ts`'s `materializeImports` (the dissolved
 *     standalone `async-ify/`/`frame/` passes' successors) both decide by
 *     `RuntimeRef.symbol` — a different field entirely, untouched by this
 *     mutation regardless of ordering.
 *   - `render()` reads `.text` only at the final print step.
 *
 * (b) rewrites every destructured param site structurally (Binding → ArrayPattern for
 * positional destructure, ObjectPattern for the dict-field shape —
 * naming lane item 2), substituting qualifying occurrences with `Ref`s to the
 * new slot/field bindings — the same tree surgery the dissolved
 * legibility/destructure.ts used to perform as an independent decide-and-
 * rewrite pass, now applied from a PRE-COMPUTED decision instead.
 *
 * ── Why this is ONE combined pass, not "generic rewrite, then substitute" ───
 * `NameAllocation.destructureOf`/`fieldDestructureOf`'s occurrence maps are
 * keyed by node IDENTITY over the PROVISIONAL tree census read. A naive
 * two-step "reconstruct the whole tree generically, then substitute
 * occurrences" would invalidate those keys: `mapChildren` always builds a NEW
 * object for every non-leaf node it visits, so an `Index` node census
 * recorded would no longer `===`-match anything in an already-reconstructed
 * tree. The fix (mirrored from legibility/tree.ts's own `substituteBy`):
 * check whether THIS node is a qualifying occurrence BEFORE recursing into
 * its children, on the ORIGINAL (still-provisional-identity) tree — swap and
 * stop, or recurse and keep looking. All destructure decisions (both shapes)
 * are flattened into ONE identity-keyed map up front so this check is a
 * single lookup regardless of how many params destructure in the unit.
 */
import { mapChildren } from "../legibility/tree.js";
import type { CompilationUnit, Decl, Param, R } from "../residual/types.js";
import { ArrayPattern, ObjectPattern, Ref } from "../residual/types.js";
import type { NameAllocation } from "./types.js";

/** Replace every destructured param's Pattern with an ArrayPattern (positional)
 *  or ObjectPattern (dict-field) of its allocated slots — `mapChildren`'s
 *  Arrow case never touches `.params` (only `.body`), so the ORIGINAL Param
 *  objects (and their Binding references) are exactly what a caller still
 *  holds after body recursion; no identity concern here, only for occurrence
 *  nodes (handled by the caller's flattened `replacements` map). The two
 *  shapes are mutually exclusive per param (allocate.ts never populates both
 *  maps for the same Binding), so at most one branch fires per param. */
function withDestructuredParams(params: readonly Param[], allocation: NameAllocation): readonly Param[] | undefined {
  let changed = false;
  const next = params.map((p) => {
    if (p.pattern.t !== "Binding") return p;
    const d = allocation.destructureOf.get(p.pattern);
    if (d !== undefined) {
      changed = true;
      return { pattern: ArrayPattern(d.slots) };
    }
    const fd = allocation.fieldDestructureOf.get(p.pattern);
    if (fd !== undefined) {
      changed = true;
      return { pattern: ObjectPattern(fd.properties) };
    }
    return p;
  });
  return changed ? next : undefined;
}

export function materializeNames(unit: CompilationUnit, allocation: NameAllocation): CompilationUnit {
  // (a) Renames — cheap, in place, order-independent; covers every occurrence
  // of a renamed Binding automatically (shared object identity).
  for (const [binding, text] of allocation.nameOf) {
    (binding as { text: string }).text = text;
  }
  if (allocation.destructureOf.size === 0 && allocation.fieldDestructureOf.size === 0) return unit;

  // (b) Flatten every destructure decision's occurrence→replacement into ONE
  // global, identity-keyed map — safe because both shapes' occurrence maps
  // are computed per-param over DISJOINT subtrees (a given occurrence node
  // can resolve to at most one param's car/cdr chain or field access —
  // census.ts's `cdrOffsetOf`/`analyzeFieldParam` both check identity against
  // ONE specific param).
  const replacements = new Map<R, R>();
  for (const { slots, positions } of allocation.destructureOf.values()) {
    for (const [node, pos] of positions) replacements.set(node, Ref(slots[pos]!));
  }
  for (const { accesses } of allocation.fieldDestructureOf.values()) {
    for (const [node, binding] of accesses) replacements.set(node, Ref(binding));
  }

  const rewrite = (n: R): R => {
    const swap = replacements.get(n);
    if (swap !== undefined) return swap; // occurrence site — stop, don't recurse further
    const recursed = mapChildren(n, rewrite);
    if (recursed.t !== "Arrow") return recursed;
    const params = withDestructuredParams(recursed.params, allocation);
    return params === undefined ? recursed : { ...recursed, params };
  };

  const rewriteDecl = (d: Decl): Decl => {
    switch (d.t) {
      case "FnDecl": {
        const body = { ...d.body, stmts: d.body.stmts.map(rewrite) };
        const params = withDestructuredParams(d.params, allocation);
        return params === undefined ? { ...d, body } : { ...d, params, body };
      }
      case "ConstDecl":
        return { ...d, init: rewrite(d.init) };
      case "DeclComment":
        return { ...d, decl: rewriteDecl(d.decl) };
      case "Import":
      case "ImportType":
      case "Export":
        return d;
    }
  };

  return {
    decls: unit.decls.map(rewriteDecl),
    body: unit.body.map(rewrite),
  };
}
