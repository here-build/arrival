/**
 * ARM-A — atoms / bindings / structure (G1 stub; Sonnet-A fills).
 *
 * Owns: Lit, Ref, Quote, Define, Let, Begin, Require, Door.
 *
 * Contracts (I1 throughout — lift or opaque, never mislabel):
 *  - Lit          → ConstProv (program-text constant, THE fabrication mark).
 *                   A keyword Lit in App-head position never reaches here (ARM-B).
 *  - Quote        → ConstProv. Quoted data is inert program text — a quoted list
 *                   is ONE const, not a build (it cannot carry evidence).
 *  - Ref          → ctx.inputs member ⇒ InputProv (evidence-class);
 *                   in-scope ⇒ extract the bound expr IN ITS BINDING SCOPE
 *                   (Bound.scope, hardening #2) with the cycle guard;
 *                   UNBOUND ⇒ InputProv — the wire-model convention (derive.ts's
 *                   PVertice): the evidence handle arrives as a free name (`e`),
 *                   bound by the run harness, not the source. Sound under
 *                   adversarial authorship because the seal is static ∧ probe:
 *                   a name unbound at RUN time crashes the run, and no run ⇒ no
 *                   probe leg ⇒ nothing attests.
 *  - Define       → attribution of its value (top-level registration is
 *                   extractProgram's job; nested defines extend scope).
 *  - Let (4 kinds)→ letKind-honoring scope extension (let: all inits in OUTER;
 *                   let*: each sees previous; letrec/letrec*: all see the new
 *                   frame — recursion through it hits the cycle guard), then
 *                   body: attribution of LAST body form (Begin semantics).
 *  - Begin        → attribution of the LAST form (earlier forms are effect
 *                   positions; their mints still exist as crossing sites but do
 *                   not flow into the value).
 *  - Require      → MintProv (a crossing: module loading penetrates the
 *                   membrane), integrity "evidence", head "require".
 *  - Door         → opaque(door.code) — the classifier already refused; extract
 *                   NEVER upgrades a Door.
 */
import type { Begin, CoreForm, Define, Door, Let, Lit, Quote, Ref, Require } from "../coreform/types.js";
import type { StaticProv } from "../model/static-prov.js";
import { type ExtractCtx, opaque } from "./index.js";

type AtomForm = Lit | Ref | Quote | Define | Let | Begin | Require | Door;

export function extractAtom(form: AtomForm, ctx: ExtractCtx): StaticProv {
  void ctx; // stub — arm agent replaces
  void (0 as unknown as CoreForm);
  return opaque(form.id, `unimplemented/arm-a/${form.kind}`);
}
