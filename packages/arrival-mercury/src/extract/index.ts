/**
 * extract — CoreForm → StaticProv, TOTAL (G1 scaffold, 2026-07-15).
 *
 * THE LAW (I1): total and fail-closed. Every CoreForm kind lifts to a
 * StaticProv or becomes `opaque` with a stable reason code. Mislabeling is the
 * only sin; `opaque` is always sound. The switch below is exhaustive WITHOUT a
 * default arm — tsc's return-type check is the totality proof; adding a 17th
 * CoreForm kind breaks this file at compile time, never silently at run time.
 *
 * Arm ownership (§2g arm-group cut; each arm is a separate module so the three
 * build in parallel — tsc exhaustiveness + this one dispatcher enforce I1
 * across the seam):
 *   ARM-A  atoms/bindings/structure  — Lit Ref Quote Define Let Begin Require Door
 *   ARM-B  application/control      — App DefineFn Lambda NamedLet If And Or
 *   ARM-C  containers + registry    — Dict, plus the HeadRegistry ARM-B calls
 *                                     for known primitive heads, plus string RLE
 *
 * Scope discipline is inherited from wire/derive.ts (its five hardenings are
 * the contract): binding-site scoping (a bound value carries the scope it was
 * bound IN), letKind honored (all four let kinds), beta-reduction of user
 * callees with a cycle guard (revisit ⇒ opaque "cyclic-binding"), kwargs folded
 * (never a silent forge channel), DefineFn in the top-level scope (the
 * named-helper forge died there).
 */
import type { CoreForm, NodeId } from "../coreform/types.js";
import type { HeadRegistry, StaticProv } from "../model/static-prov.js";

import { extractAtom } from "./arm-atoms.js";
import { extractControl } from "./arm-control.js";
import { extractContainer } from "./arm-containers.js";

/** A name bound in scope — either the EXPRESSION it was bound to plus the
 *  scope that expression must itself be read in (binding-site scoping,
 *  derive.ts hardening #2: without it, beta-reduction reads a callee's free
 *  names in the CALLER's scope and forges), or a SYNTHETIC attribution value
 *  directly (fan-body element/acc params — `buildFan` binds `element` to
 *  MuxProv{key:null} over the collection; there is no expr to defer to).
 *  ARM-A's Ref case returns `prov` directly when present. */
export type Bound = { readonly expr: CoreForm; readonly scope: Scope } | { readonly prov: StaticProv };

export interface Scope {
  readonly names: ReadonlyMap<string, Bound>;
  readonly parent: Scope | null;
}

export const EMPTY_SCOPE: Scope = { names: new Map(), parent: null };

export function lookup(scope: Scope, name: string): Bound | undefined {
  for (let s: Scope | null = scope; s; s = s.parent) {
    const hit = s.names.get(name);
    if (hit) return hit;
  }
  return undefined;
}

export interface ExtractCtx {
  readonly scope: Scope;
  readonly registry: HeadRegistry;
  /** Beta-reduction cycle guard (derive.ts hardening #1): forms currently being
   *  reduced; a revisit means recursion through bindings ⇒ the arm returns
   *  `opaque("cyclic-binding")` rather than diverging. */
  readonly reducing: ReadonlySet<CoreForm>;
  /** Program-input names (`define/overridable` params) — these Refs are
   *  evidence-class InputProv, everything else resolves through scope. */
  readonly inputs: ReadonlySet<string>;
}

export const opaque = (site: NodeId, reason: string): StaticProv => ({ kind: "opaque", site, reason });

/** The one dispatcher. Exhaustive by tsc (no default): the totality proof. */
export function extract(form: CoreForm, ctx: ExtractCtx): StaticProv {
  switch (form.kind) {
    case "Lit":
    case "Ref":
    case "Quote":
    case "Define":
    case "Let":
    case "Begin":
    case "Require":
    case "Door":
      return extractAtom(form, ctx);
    case "App":
    case "DefineFn":
    case "Lambda":
    case "NamedLet":
    case "If":
    case "And":
    case "Or":
      return extractControl(form, ctx);
    case "Dict":
      return extractContainer(form, ctx);
  }
}

/** Program-level entry: walk the top-level forms with defines in scope (the
 *  named-helper forge's fix — DefineFn IS in the top-level scope), return the
 *  attribution of the LAST value form (the program's result, matching
 *  discovery-run's `userForms.at(-1)` convention). */
export function extractProgram(forms: readonly CoreForm[], registry: HeadRegistry): StaticProv {
  const names = new Map<string, Bound>();
  const top: Scope = { names, parent: null };
  const inputs = new Set<string>();
  for (const f of forms) {
    if (f.kind === "Define") {
      if (f.overridableType !== undefined) {
        // A define/overridable is a program INPUT: bind it in scope as the
        // synthetic InputProv (evidence-class), NOT as its fallback expr — the
        // override is always supplied by the harness, and the fallback must
        // never become the attribution. Binding through the ORDINARY scope
        // (rather than a scope-bypassing inputs check) is load-bearing: an
        // inner `(let ((e "FAB")) e)` shadow must attribute to the shadow's
        // const, never to the input — the shadowed-input forge (corpus row 6).
        names.set(f.name, { prov: { kind: "input", site: f.id, name: f.name } });
        inputs.add(f.name);
      } else {
        names.set(f.name, { expr: f.value, scope: top });
      }
    }
    if (f.kind === "DefineFn") names.set(f.name, { expr: f, scope: top });
  }
  const last = forms.filter((f) => f.kind !== "Define" && f.kind !== "DefineFn").at(-1) ?? forms.at(-1);
  if (!last) return { kind: "opaque", site: 0 as NodeId, reason: "empty-program" };
  return extract(last, { scope: top, registry, reducing: new Set(), inputs });
}
