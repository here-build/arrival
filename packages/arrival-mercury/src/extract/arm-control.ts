/**
 * ARM-B — application / control (G1 stub; Sonnet-B fills).
 *
 * Owns: App, DefineFn, Lambda, NamedLet, If, And, Or.
 *
 * Contracts (I1 throughout):
 *  - If   → ChoiceProv { guards:[extract(cond)], alts:[extract(then), extract(else)] }.
 *           BOTH alts extracted — gray wires are the design's core claim. A
 *           literal alt stays a visible ConstProv (the guard-swap forge's
 *           signature; the verdict channel reads it, extract never hides it).
 *  - And/Or → ChoiceProv; args are both guards AND alts (each arg can be the
 *           result and gates the rest). guards = args[0..n-1], alts = args.
 *  - App  → resolve the callee:
 *           · user fn (scope/DefineFn/Lambda) ⇒ BETA-REDUCE (derive.ts
 *             hardenings: cycle guard ⇒ opaque("cyclic-binding"); arity
 *             mismatch/variadic ⇒ opaque("callee-arity"); params bound to ARG
 *             ATTRIBUTIONS in the callee's own scope).
 *           · keyword head (`:field`) ⇒ MuxProv over the argument.
 *           · known primitive ⇒ ctx.registry.classifyHead(name) — fuse/mux/
 *             build/string/mint/fan/choice/opaque per HeadClass (fan kinds
 *             desugar to FanProv via ARM-C's fan builder; T3b wires collapse
 *             inference, until then collapse = "lowered" ALWAYS — sound).
 *           · kwargs FOLD into the argument set (hardening #4 — never a silent
 *             forge channel); kwargs-only call to an unknown head ⇒ opaque.
 *           · anything else ⇒ opaque("unknown-callee").
 *  - DefineFn/Lambda in VALUE position (not being applied) → the fn as a value
 *           is program text: ConstProv? NO — it closes over scope; a later App
 *           beta-reduces it. As a leaf value it is opaque("fn-as-value") until
 *           the callable-as-value design (tagless apply) lands. Fail closed.
 *  - NamedLet → the loop form: recursion knot. Bindings seed the frame; the
 *           body extracts with the loop name bound; a recursive call hits the
 *           cycle guard and the whole loop lifts to FanProv over the SEED
 *           attributions with collapse "lowered" (a loop is a fold in a coat) —
 *           or opaque("named-let/unliftable") where the shape resists. Never
 *           collapse.
 */
import type { And, App, CoreForm, DefineFn, If, Lambda, NamedLet, Or } from "../coreform/types.js";
import type { StaticProv } from "../model/static-prov.js";
import { type ExtractCtx, opaque } from "./index.js";

type ControlForm = App | DefineFn | Lambda | NamedLet | If | And | Or;

export function extractControl(form: ControlForm, ctx: ExtractCtx): StaticProv {
  void ctx; // stub — arm agent replaces
  void (0 as unknown as CoreForm);
  return opaque(form.id, `unimplemented/arm-b/${form.kind}`);
}
