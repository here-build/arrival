/**
 * LEGIBILITY leg 2 — element-name singularization (constitution §3.5). A `.map`
 * callback's SOLE, fresh-minted (never user-authored) leading parameter renames
 * to the singular of the receiver collection's name:
 *
 *   examples.map((__item) => …)   →   examples.map((example) => …)
 *
 * "Fresh-minted" is detected structurally, not by provenance-tracking: `fresh()`
 * (walk.ts) is the ONLY minting path able to produce a leading-`__` binding text
 * (`cleanName` can never itself emit one — walk.ts's own header comment, and this
 * package's `mintFresh`/`mintReadable` split in tree.ts follows the same
 * convention). A parameter whose name does NOT start with `__` is the user's own
 * choice and is never touched — an inline lambda passed directly to `map`
 * (`(map (lambda (x) …) examples)`) compiles `x` unchanged, because `mapRule`
 * (phase1.ts) forwards the single-list callback `f` as-is; the ONLY residual
 * shape where THIS wave's `mapRule` mints a fresh callback param is the
 * multi-list zip (`freshBinding(ctx, "item")` / `"i"`), which is exactly what
 * this leg improves.
 *
 * Scope: `Method(_, "map", [Arrow, …])` nodes only — the mission's literal
 * example. `filter`/`every`/`some`/`forEach` are a natural follow-up (their
 * receivers carry the same naming opportunity), deliberately not landed here to
 * keep this leg's surface matched to what was asked and tested.
 */
import { elementNameOf } from "./names.js";
import { collectBoundNames, mapChildren, mintReadable, substituteBy } from "./tree.js";
import type { Binding, CompilationUnit, Decl, R } from "../residual/types.js";

const FRESH_PREFIX = "__";

/** Rewrite `n` if it is a qualifying `.map` call; otherwise return it unchanged. */
function trySingularize(n: R, taken: Set<string>): R {
  if (n.t !== "Method" || n.name !== "map" || n.args.length === 0) return n;
  const arrow = n.args[0]!;
  if (arrow.t !== "Arrow" || arrow.params.length === 0) return n;
  const firstParam = arrow.params[0]!;
  if (firstParam.pattern.t !== "Binding" || !firstParam.pattern.text.startsWith(FRESH_PREFIX)) return n;
  const singular = elementNameOf(n.recv);
  if (singular === undefined) return n;

  const oldBinding: Binding = firstParam.pattern;
  const newBinding = mintReadable(singular, taken);
  const newBody = substituteBy(arrow.body, (m) => (m.t === "Ref" && m.binding === oldBinding ? { t: "Ref" as const, binding: newBinding } : undefined));
  const newArrow = {
    ...arrow,
    params: [{ ...firstParam, pattern: newBinding }, ...arrow.params.slice(1)],
    body: newBody,
  };
  return { ...n, args: [newArrow, ...n.args.slice(1)] };
}

function rewriteNode(n: R, taken: Set<string>): R {
  const recursed = mapChildren(n, (child) => rewriteNode(child, taken));
  return trySingularize(recursed, taken);
}

function rewriteDecl(d: Decl, taken: Set<string>): Decl {
  switch (d.t) {
    case "FnDecl":
      return { ...d, body: { ...d.body, stmts: d.body.stmts.map((s) => rewriteNode(s, taken)) } };
    case "ConstDecl":
      return { ...d, init: rewriteNode(d.init, taken) };
    case "DeclComment":
      return { ...d, decl: rewriteDecl(d.decl, taken) };
    case "Import":
    case "ImportType":
    case "Export":
      return d;
  }
}

/** The whole-unit entry point. Pure: never mutates `unit`. */
export function singularizeHofParams(unit: CompilationUnit): CompilationUnit {
  const taken = collectBoundNames(unit);
  return {
    decls: unit.decls.map((d) => rewriteDecl(d, taken)),
    body: unit.body.map((s) => rewriteNode(s, taken)),
  };
}
