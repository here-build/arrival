/**
 * v02-G0 FEASIBILITY SPIKE — the AUTO-BINDING runtime leaf-stamp (design
 * docs/working-proposals/provenance-static-lineage-v0.2-lens-carrier-2026-06-20.md
 * §"v02-G0 feasibility verdict + design"). ADDITIVE + flag-gated + fully reversible.
 *
 * THE PROBLEM IT SOLVES. The v02-G1 shadow (lineage-field-shadow.test.ts) proves the
 * static carrier (`classify` + `fieldResolve`) reproduces the live field-point queries
 * — but only against MANUALLY-assembled bindings (`{ infer: inferIds }`, a global
 * name→ids map). That manual map COLLAPSES the distinct invocations of one source name:
 * `(map infer xs)` over 3 elements mints 3 producer ids, yet the static tree has one
 * `infer` node, so `{ infer: [a,b,c] }` cannot say "THIS element-projection reads
 * producer `b` specifically" — exactly the distinction the dag's causal edges depend on.
 *
 * THE FIX — bind PER-VALUE / PER-INVOCATION, never per-name. Each value already carries
 * its producer id(s) in `AValue.provenance` (the eager stamp, mechanism 1, placed at the
 * source's exit, rosetta.ts:459 → trace.ts:496). So the auto-binding does NOT mint a new
 * id; it CAPTURES the producer ids a runtime value carries, keyed to the CONSUMER
 * INVOCATION that read it (its scope), not to a global slot. When `reflect`'s body reads
 * `reactions` (bound to `(list (react …))`, whose element carries react's producer id),
 * the capture scoped to THAT invocation records `reactions → {react's id}` — and crucially
 * NOT reflect's own infer id, which is not reachable in the `reactions` value. The aliasing
 * dissolves because each capture is scoped to one invocation's symbol resolutions.
 *
 * This GENERALIZES the already-shipped `argProvenance → buildInputsProvenance`
 * `slot→producer-id[]` map (rosetta.ts:416-418): that builds it for `.prompt` kwargs from
 * `deepProvenance(arg)`; this builds the SAME shape for the carrier's free leaf slots from
 * `deepProvenance(symbol-value)`, scoped per invocation.
 *
 * HOOK + REVERSIBILITY. An `AutoBindings` instance is attached to an `EvalTrace`
 * explicitly (the flag). When present, the trace's `exit` records this invocation's
 * symbol resolutions (already in `trace.symbolValues`) into it. When ABSENT (the default)
 * the trace touches nothing — byte-identical to today. Deleting this file + the one
 * `recordInvocation` call in trace.ts fully reverts the spike.
 */
import { AValue } from "./AValue.js";
import { is_pair } from "./value-guards.js";
import { SchemeVector } from "./SchemeVector.js";
import type { Bindings, LineageNode } from "./lineage.js";

/** The free LEAF/SOURCE slots a classified skeleton references — the slots an auto-binding
 *  must resolve. A read-only walk over the static tree (mirrors lineage-shadow.ts's
 *  `collectSlots`, kept here so the spike is self-contained; M1 will later fold both into
 *  `walk`). Descends a `field`'s focused child only — siblings were pruned at classify. */
export function slotsOf(n: LineageNode, out: Set<string> = new Set()): Set<string> {
  switch (n.kind) {
    case "literal":
      return out;
    case "leaf":
      out.add(n.slot);
      return out;
    case "source":
      out.add(n.op);
      return out;
    case "pipe":
    case "field":
      slotsOf(n.child, out);
      return out;
    case "fan":
      slotsOf(n.source, out);
      if (n.template) slotsOf(n.template, out);
      return out;
    case "mux":
      slotsOf(n.selector, out);
      n.arms.forEach((a) => slotsOf(a, out));
      return out;
    case "merge":
    case "opaque":
      n.children.forEach((ch) => slotsOf(ch, out));
      return out;
  }
}

/** Deep provenance of a runtime value: every producer id reachable from it — itself, a
 *  Pair's car/cdr spine, a vector's elements (a packed list/vector leaves the SPINE's
 *  provenance empty, so origins live on the elements). Mirrors rosetta.ts's
 *  `deepProvenance` (340-369), inlined here to keep this value-layer module dependency-
 *  light (it is the same reachability the eager stamp's union walks). Cycle-guarded. */
function deepProvenance(value: unknown): Set<number> {
  const acc = new Set<number>();
  const seen = new Set<unknown>();
  const walk = (v: unknown): void => {
    if (v === null || typeof v !== "object") return;
    if (seen.has(v)) return;
    seen.add(v);
    if (v instanceof AValue) {
      for (const p of v.provenance) acc.add(p);
      if (is_pair(v)) {
        walk(v.car);
        walk(v.cdr);
      } else if (v instanceof SchemeVector) {
        for (const el of v.__vector__) walk(el);
      }
    } else if (Array.isArray(v)) {
      for (const el of v) walk(el);
    }
  };
  walk(value);
  return acc;
}

/**
 * The additive, flag-gated AUTO-BINDING sidecar. Populated by `EvalTrace.exit` (only when
 * an instance is attached — otherwise the trace never touches it). Records, PER CONSUMER
 * INVOCATION, the producer ids each symbol it resolved carries — the per-value binding the
 * carrier's `fieldResolve` needs, scoped so distinct invocations of one source name never
 * collapse.
 *
 * NOT a global `name → ids` map. The outer key is the consumer INVOCATION id; the inner
 * map is that invocation's `slot → producer-ids`. The same source name (`infer`) read in
 * two invocations lands under two distinct invocation ids with its own per-call producer
 * set — the exact structure the dag's distinct-invocation edges need.
 */
export class AutoBindings {
  /** consumer-invocation id → (free-symbol slot → the producer ids that slot's runtime
   *  value carried, at THIS invocation). */
  readonly byInvocation = new Map<number, Map<string, Set<number>>>();

  /**
   * Record one invocation's symbol resolutions (the leaf-stamp). Called from the trace's
   * `exit` with the invocation id and the `name → value` map the trace already captured in
   * `symbolValues`. For each resolved symbol carrying provenance, store its deep producer
   * ids under this invocation. Empty-provenance symbols are skipped (they bind nothing).
   *
   * This is the "record slot→producer-id as a (consumed) value flows" step — the producer
   * id rode in on `value.provenance` from the source's own exit; we capture it scoped to
   * the reader, which is what makes the binding per-value.
   */
  recordInvocation(invocationId: number, symbolValues: ReadonlyMap<string, unknown> | undefined): void {
    if (!symbolValues || symbolValues.size === 0) return;
    let slots: Map<string, Set<number>> | undefined;
    for (const [name, value] of symbolValues) {
      const ids = deepProvenance(value);
      if (ids.size === 0) continue;
      if (!slots) {
        slots = this.byInvocation.get(invocationId) ?? new Map();
        this.byInvocation.set(invocationId, slots);
      }
      const existing = slots.get(name);
      if (existing) for (const id of ids) existing.add(id);
      else slots.set(name, ids);
    }
  }

  /** Find the invocation that resolved `slot` and read its producer ids — the per-value
   *  binding for a carrier leaf. When several invocations resolved the same slot (a slot
   *  read in a loop), `pick` selects one; default = the FIRST recorded (lowest invocation
   *  id). Returns `[]` if no invocation carried producer ids for the slot. */
  producersFor(slot: string, pick?: (candidates: { invocationId: number; ids: Set<number> }[]) => number[]): number[] {
    const candidates: { invocationId: number; ids: Set<number> }[] = [];
    for (const [invocationId, slots] of this.byInvocation) {
      const ids = slots.get(slot);
      if (ids && ids.size > 0) candidates.push({ invocationId, ids });
    }
    if (candidates.length === 0) return [];
    if (pick) return [...pick(candidates)].sort((a, z) => a - z);
    candidates.sort((a, z) => a.invocationId - z.invocationId);
    return [...candidates[0]!.ids].sort((a, z) => a - z);
  }

  /**
   * Assemble a `Bindings` for a classified skeleton's free LEAF/SOURCE slots — the auto
   * analogue of `bindingsForSkeleton` (lineage-shadow.ts:134), but each slot resolves to
   * the producer ids the RUNTIME VALUE carried (per-value), not `provOf(env.get(slot))`
   * (which reads the top-level env where a lambda-param leaf like `reactions` isn't even
   * bound). `slots` is the set the skeleton references (the consumer reads it off
   * `classify`'s tree via `collectSlots`).
   */
  bindingsFor(slots: Iterable<string>): Bindings {
    const b: Record<string, readonly number[]> = {};
    for (const slot of slots) {
      const ids = this.producersFor(slot);
      if (ids.length > 0) b[slot] = ids;
    }
    return b;
  }
}
