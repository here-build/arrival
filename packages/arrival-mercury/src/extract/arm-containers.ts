/**
 * ARM-C — containers + the primitive-head registry + string RLE (G1 stub;
 * Sonnet-C fills).
 *
 * Owns: Dict (the one union arm), plus TWO exported contracts the other arms
 * call through:
 *   1. `defaultRegistry` — the HeadRegistry (model/static-prov.ts): TOTAL head
 *      classification. The enumerated tables live HERE, auditable in one place:
 *        fuse   : + - * / = < > <= >= abs min max not string-length hash …
 *        mux    : car cdr first rest nth vector-ref assoc dict-ref (static key)
 *        build  : cons list vector dict make-vector
 *        string : string-append string-join substring format
 *        mint   : infer infer/chat now uuid random read-file require/eval —
 *                 integrity "evidence" for recorded crossings, "ambient" for
 *                 now/uuid/random (I3's third verdict).
 *        fan    : map filter fold reduce for-each fold-left fold-right
 *        UNKNOWN⇒ {role:"opaque", reason:"unknown-head/<name>"} — TOTAL (I1).
 *   2. `buildFan` — the Fan constructor ARM-B calls for fan-role heads:
 *      desugar per §2c (`(map f v)` = Fan(collect, f(unwind v)); filter = Fan
 *      over choice; fold = Fan over the op body with acc). Collapse kind is
 *      ALWAYS "lowered" until T3a's inference wires in (sound: lowered keeps
 *      every internal choice/const visible — the fold-collapse forge cannot
 *      arise). String RLE: string-role heads build StringProv with run order
 *      preserved (the materialized value's order matters; grounding reads the
 *      run SET, order-blind).
 *
 *  - Dict → BuildProv{ctor:"dict"}, per-entry attribution (KwEntry values each
 *    extract; keys are program text and do NOT contribute a const — a key is
 *    structure, not content).
 */
import type { CoreForm, Dict, NodeId } from "../coreform/types.js";
import type { HeadClass, HeadRegistry, StaticProv } from "../model/static-prov.js";
import { type ExtractCtx, opaque } from "./index.js";

export function extractContainer(form: Dict, ctx: ExtractCtx): StaticProv {
  void ctx; // stub — arm agent replaces
  void (0 as unknown as CoreForm);
  return opaque(form.id, `unimplemented/arm-c/${form.kind}`);
}

/** G1 placeholder registry: TOTAL by construction — everything opaque. ARM-C
 *  replaces the body with the enumerated tables; the signature is frozen. */
export const defaultRegistry: HeadRegistry = {
  classifyHead(name: string): HeadClass {
    return { role: "opaque", reason: `unknown-head/${name}` };
  },
};

/** The Fan constructor — ARM-B delegates here for fan-role heads (`map`,
 *  `filter`, `fold`, …). Signature FROZEN at G1 so the arms build in parallel;
 *  ARM-C fills the body per §2c's desugar rules:
 *    map    → Fan(collection, body = extract of `(fn element)`)
 *    filter → Fan(collection, body = choice over the predicate)
 *    fold   → Fan(collection, body = extract of `(fn acc element)` with acc
 *             bound to init's attribution, element to the collection element)
 *  `element` inside the body = MuxProv{key: null, source: collection} — the
 *  distinguished element-of-collection projection. Collapse is ALWAYS
 *  "lowered" until T3a's inference wires in (sound: every internal choice and
 *  const stays visible; the fold-collapse forge cannot arise). */
export function buildFan(
  fanKind: "map" | "filter" | "fold",
  site: NodeId,
  fn: CoreForm,
  collection: StaticProv,
  init: StaticProv | null,
  ctx: ExtractCtx,
): StaticProv {
  void fn;
  void collection;
  void init;
  void ctx; // stub — arm agent replaces
  return opaque(site, `unimplemented/arm-c/fan-${fanKind}`);
}
