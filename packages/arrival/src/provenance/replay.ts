/**
 * provenance/replay.ts — THE REPLAY DRIVERS the replay laws run over. Three faces,
 * one ruling (R1): replay from frozen port payloads is stable. Replay NEVER
 * re-invokes a source; retrospective mint records are authoritative.
 *
 *   1. `replayGraphEgress` — the per-wire γ COMPOSITION over a wireframe graph:
 *      every wire is `applyWireInEnv` (gamma.ts) against ingress resolved from its
 *      `paramRefs` — a designated node's replay value for `node` refs, a caller
 *      binding for `slot` refs. Loop-FREE scope by construction (the Galois
 *      adjunction is claimed for loop-free wires only) — a `binder` node is a
 *      teaching door here, never a silent approximation.
 *   2. `replayProgramWithPlayback` — the whole-program mode plus the loop
 *      reconstruction step: re-run the ENTIRE program under a silent region with
 *      every membrane penetration answered from the RECORDED payload stream
 *      ("cached membrane behavior + whole-program re-run"); the live world is
 *      never consulted because the playback sources are the only ones bound.
 *   3. `replayBetweenRecords` — for effect tracks: "pure stretches applied,
 *      recorded port events interleaved verbatim." Composes fold.ts (the region
 *      must have completed — its post-hoc mirror), the stream (mint records in seq
 *      order ARE the verbatim events, ground truth, never re-derived or re-sorted),
 *      and gamma.ts (each pure stretch is a γ over the chained accumulator + the
 *      recorded event payload — the ONE sanctioned inter-track edge:
 *      `egress(Tᵢ) → ingress(Tᵢ₊₁)`).
 *
 * ── DESIGN CALLS (each binds where it is implemented below) ──────────────────────
 * D1 — frozen-ingress keying is PER-OP FIFO (`FrozenMints`): the fuller key is
 *      (template-hash, ordinal-path, region epoch), but nothing at HEAD advances a
 *      per-node coordinate during a live run yet (the wireframe-walking driver is
 *      future work — eval/provenance-hooks.ts's own header says so). Demand order
 *      during a loop-free replay matches emission order PER OP, so op-keyed FIFO
 *      queues are exact for the law corpus; two same-op sources where only one fired
 *      would be ambiguous — the corpus keeps arm ops distinct, and the limitation is
 *      this note, not silent behavior.
 * D2 — an UNRECORDED node demanded at wire-binding time (a pure-mux wire's untaken
 *      arm — its params are the wire's full FV set, a wire-locality trade-off; a
 *      sink's sequencing reference) binds a SENTINEL stamped value from a reserved
 *      id range (≥ SENTINEL_BASE). γ never lets a sentinel FLOW to an egress the
 *      recorded run produced — the laws assert `cone(egress) ∩ sentinels = ∅`,
 *      surfacing that soundness as a checkable fact instead of a silent hole.
 * D3 — port-coupled mux decisions: a caller-supplied recorded decision map takes
 *      precedence (frozen records authoritative); ABSENT one, the arm is DERIVED by
 *      γ-ing the selector wire (its cone reaches only ports whose payloads are
 *      frozen, so the derivation is closed). Nothing at HEAD emits a
 *      `MuxDecisionRecord` from a live run yet (the emission core exists, the
 *      evaluator-side trigger is the same future walking driver as D1) — named gap,
 *      not papered over.
 * D4 — `fan`/`binder`/`transparent`/`opaque` nodes are TEACHING DOORS in the
 *      per-wire driver (`ReplayScopeError`): fans replay as regions (their per-
 *      element tracks γ independently — the track laws do exactly that — or the
 *      whole program replays via playback); binders are the loop half wire-γ does
 *      not claim; transparent/opaque crossings have no recorded payload to be
 *      stable FROM. Refusal-with-route, never a wrong value.
 */
import { execState } from "../eval/generator-exec.js";
import type { EnvironmentValue, ResolvingEnvironment } from "../Environment.js";
import { collapseProvenance } from "../provenance-collapse.js";
import { AValue } from "../values/primitives/AValue.js";
import { jsToScheme, schemeToJs } from "../rosetta.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { withSilentRegion } from "../values/primitives/region-scope.js";
import type { SchemeValue } from "../values/types.js";
import type { EnvCapability } from "../common/capability.js";
import { applyWireInEnv } from "./gamma.js";
import { hermeticEnv, type IngressBindings } from "./hermetic-env.js";
import { foldRegionStream } from "./store/fold.js";
import type { Payload, PayloadStore, ProvenanceStore } from "./store/interfaces.js";
import type { MintRecord } from "./store/records.js";
import type { RegionId } from "./store/ids.js";
import type { EmittedWire, Wire, WireframeGraph, WireframeProgram } from "./wireframe/types.js";

/** The teaching door for replay demands outside a driver's claimed scope — names
 *  WHAT was demanded, WHY the driver refuses, and WHERE the demand is served
 *  instead (errors-as-doors: a rejection routes, it never just bans). */
export class ReplayScopeError extends Error {
  constructor(
    readonly nodeKind: string,
    readonly span: string,
    teach: string,
  ) {
    super(`replay: ${nodeKind} node at ${span} is outside this driver's scope — ${teach}`);
    this.name = "ReplayScopeError";
  }
}

/** Sentinel stamp ids live at/above this base — far outside any eager-oracle mint
 *  range a test registry produces (those count up from 1) and outside any recorded
 *  stamp id, so `cone ∩ sentinels` is a meaningful emptiness check, never a
 *  coincidence. */
export const SENTINEL_BASE = 1 << 30;

let nextSentinel = SENTINEL_BASE;

/** D1 — the frozen retrospective side a graph replay reads INSTEAD of the world:
 *  per-op FIFO queues of recorded mint payloads (emission order preserved), plus
 *  the sentinel ledger (D2) the laws assert non-flow against. */
export class FrozenMints {
  private readonly queues = new Map<string, Payload[]>();
  /** sentinel id → which node demanded it (op + span) — the D2 ledger. */
  readonly sentinels = new Map<number, string>();

  /** Append one recorded payload for `op` — call in stream (seq) order. */
  push(op: string, payload: Payload): void {
    const q = this.queues.get(op);
    if (q === undefined) this.queues.set(op, [payload]);
    else q.push(payload);
  }

  /** Pop the next recorded payload for `op`, or `undefined` when the record run
   *  never (or never again) crossed it — the caller decides sentinel vs door. */
  next(op: string): Payload | undefined {
    return this.queues.get(op)?.shift();
  }

  /** Mint one sentinel stamped value for an unrecorded demand (D2). */
  sentinel(desc: string): SchemeValue {
    const id = nextSentinel++;
    this.sentinels.set(id, desc);
    return jsToScheme(CONSTANT_CTX, `#sentinel:${id}`, {}, new Set([id]));
  }
}

/** Union `taintFrom`'s (deep) provenance into `value`'s own stamp set — the
 *  port-coupled-mux control-dependency: the taken arm's replayed value carries the
 *  selector's cone, mirroring the eager oracle's own `if` semantics (and the
 *  wireframe backward cone, which walks the selector wire). Exported so
 *  `replay-walk.ts`'s step generator can reimplement this file's per-node switch to
 *  get YIELD points inside it (this closure has none to offer — `nodeValue` is
 *  private to `replayGraphIn`) while applying the IDENTICAL control-dependency union
 *  at its own mux step, rather than a second, driftable copy of this law. */
export function withUnionedProvenance(value: SchemeValue, taintFrom: SchemeValue): SchemeValue {
  if (!(value instanceof AValue)) return value;
  const taint = collapseProvenance(taintFrom);
  if (taint.size === 0) return value;
  const merged = new Set<number>([...value.provenance, ...taint]);
  return value.withProvenance(merged);
}

/** A D2 payload → boxed scheme value carrying its recorded stamp ids, so replayed
 *  cones survive the freeze/thaw round-trip. `jsToScheme` is the SAME membrane
 *  boxing a live rosetta return crosses — one boxing idiom, not a second. */
export function boxPayload(payload: Payload): SchemeValue {
  return jsToScheme(CONSTANT_CTX, payload.value, {}, new Set(payload.stampIds));
}

/** One replayed value, both faces: boxed (cone queries) + peeled (payload-value
 *  comparisons — the same `schemeToJs` peel `payloadOf`/uneval use). */
export interface ReplayedValue {
  readonly boxed: SchemeValue;
  readonly value: unknown;
}

export interface ReplayGraphOptions {
  readonly program: WireframeProgram;
  /** Which graph to replay — defaults to `program.main`; a track law hands a fan's
   *  `template` interior here to replay ONE element track. */
  readonly graph?: WireframeGraph;
  /** D1 — the frozen mint stream the replay reads instead of the world. */
  readonly frozen: FrozenMints;
  /** Free `slot` bindings: program ingress, or a template/track's formals. */
  readonly slots?: IngressBindings;
  /** D3 — recorded port-coupled mux decisions (graph node index → taken arm),
   *  authoritative when present; selector-γ derivation otherwise. */
  readonly decisions?: ReadonlyMap<number, number>;
  readonly basePacks?: readonly EnvCapability[];
  readonly config?: object;
}

/**
 * Face 1 — per-wire γ composition over a loop-free wireframe graph: the egress
 * value of `graph` under frozen ingress, computed by γ-ing each demanded wire
 * against the replay values of the nodes it consumes. Lazy + memoized per node, so
 * an untaken port-coupled arm's subgraph is never demanded (and never consumes a
 * frozen payload) — exactly the record-run's own demand shape.
 */
export async function replayGraphEgress(opts: ReplayGraphOptions): Promise<ReplayedValue> {
  const { program, frozen, decisions, slots = {}, basePacks = [], config } = opts;
  const graph = opts.graph ?? program.main;
  return withSilentRegion(async () => {
    const base = await hermeticEnv(basePacks, program.prelude.source, {}, config);
    const boxed = await replayGraphIn(base, program, graph, frozen, slots, decisions);
    return { boxed, value: schemeToJs(boxed, {}) };
  });
}

/** The recursive walk `replayGraphEgress` wraps (shared base env, one silent region). */
async function replayGraphIn(
  base: ResolvingEnvironment,
  program: WireframeProgram,
  graph: WireframeGraph,
  frozen: FrozenMints,
  slots: IngressBindings,
  decisions: ReadonlyMap<number, number> | undefined,
): Promise<SchemeValue> {
  const nodeMemo = new Map<number, SchemeValue>();

  const wireFor = (node: number, slot: string): Wire => {
    const wire = graph.wires.find((w) => w.consumer.node === node && w.consumer.slot === slot);
    if (wire === undefined) {
      const kind = graph.nodes[node]?.kind ?? "?";
      throw new ReplayScopeError(
        kind,
        graph.nodes[node]?.span ?? "?",
        `no wire feeds slot "${slot}" — record gap or builder gap; nothing to γ`,
      );
    }
    return wire;
  };

  const gammaWire = async (wire: EmittedWire): Promise<SchemeValue> => {
    const ingress: Record<string, EnvironmentValue> = {};
    for (const ref of wire.paramRefs) {
      if (ref.kind === "slot") {
        const bound = slots[ref.name];
        if (bound === undefined) {
          throw new ReplayScopeError(
            "slot",
            wire.span,
            `free slot "${ref.name}" has no caller binding — program ingress must be supplied to replay`,
          );
        }
        ingress[ref.name] = bound;
      } else {
        ingress[ref.name] = await nodeValue(ref.node);
      }
    }
    return applyWireInEnv(base, wire, ingress);
  };

  const nodeValue = async (idx: number): Promise<SchemeValue> => {
    const memo = nodeMemo.get(idx);
    if (memo !== undefined) return memo;
    const node = graph.nodes[idx];
    let value: SchemeValue;
    switch (node.kind) {
      case "source": {
        // R1 — NEVER re-invoke: the recorded payload IS the value; an unrecorded
        // demand (untaken pure-mux arm) is a sentinel (D2), never a live call.
        const payload = frozen.next(node.op);
        value = payload === undefined ? frozen.sentinel(`source:${node.op}@${node.span}`) : boxPayload(payload);
        break;
      }
      case "sink":
        // A sink has no egress — a wire referencing one is sequencing residue.
        // Sentinel (D2): γ must DISCARD it, and the laws check it never flows.
        value = frozen.sentinel(`sink:${node.op}@${node.span}`);
        break;
      case "mux": {
        // D3: a recorded decision is authoritative for the ARM; absent one, the arm
        // is DERIVED by γ-ing the selector — its cone reaches only ports, whose
        // payloads are frozen above. The selector γ's ALWAYS: a port-coupled mux's
        // egress carries its selector's provenance (control dependency — the eager
        // oracle taints the taken arm's value with the test's stamps, and the
        // wireframe's backward cone walks the selector wire — both include it),
        // so the replayed value must too.
        const selBoxed = await gammaWire(wireFor(idx, "selector"));
        let arm = decisions?.get(idx);
        if (arm === undefined) {
          const taken = schemeToJs(selBoxed, {}) !== false; // scheme truth: only #f is false
          arm = taken ? 0 : 1;
        }
        const armValue = await gammaWire(wireFor(idx, `arm${arm}`));
        value = withUnionedProvenance(armValue, selBoxed);
        break;
      }
      case "template-ref": {
        // A port-reaching define's call site: γ the arg wires, bind the template's
        // formals, replay its private graph (its interior sources read the SAME
        // frozen stream — demand order matches the record run's, loop-free).
        const template = program.templates.get(node.name);
        if (template?.graph.egress == null) {
          throw new ReplayScopeError(
            "template-ref",
            node.span,
            `template "${node.name}" is absent or has no egress — nothing to replay`,
          );
        }
        const args: Record<string, EnvironmentValue> = {};
        for (let k = 0; k < template.params.length; k++) {
          args[template.params[k]] = await gammaWire(wireFor(idx, `arg${k}`));
        }
        value = await replayGraphIn(base, program, template.graph, frozen, args, decisions);
        break;
      }
      case "fan":
        throw new ReplayScopeError(
          "fan",
          node.span,
          "a region replays as TRACKS (γ its template per element — the track laws' shape) or via whole-program playback (`replayProgramWithPlayback`), never as a single wire value",
        );
      case "binder":
      case "recur":
        throw new ReplayScopeError(
          node.kind,
          node.span,
          "loops are the half wire-γ does NOT claim (widening makes loop cones non-least); exact reconstruction is one γ-step away via aggregation count + quoted body — `replayProgramWithPlayback`",
        );
      case "transparent":
      case "opaque":
        throw new ReplayScopeError(
          node.kind,
          node.span,
          "a crossing with no recorded payload has nothing to be stable FROM — record it (source) or declare it pure",
        );
      case "port":
        throw new ReplayScopeError("port", node.span, "the out-port is the egress consumer, never a value producer");
      default: {
        const never: never = node;
        throw new ReplayScopeError(String((never as { kind?: string }).kind), "?", "unhandled node kind");
      }
    }
    nodeMemo.set(idx, value);
    return value;
  };

  if (graph.egress === null) {
    throw new ReplayScopeError(
      "port",
      "?",
      "graph has no value egress (all-defines or sink-tail program) — nothing to replay",
    );
  }
  return gammaWire(wireFor(graph.egress, "out"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Face 2 — whole-program replay with penetration playback; also the
// loop-reconstruction γ-step: aggregation count + quoted body — the recorded
// stream carries exactly `count` payloads per op, and the quoted body is the
// program source itself.
// ─────────────────────────────────────────────────────────────────────────────

export interface PlaybackReplayOptions {
  /** The FULL program source (defines included) — re-run the ENTIRE program. */
  readonly source: string;
  /** Recorded penetrations per op, in stream order — the "cached membrane
   *  behavior"; every op the program crosses MUST have its queue here. */
  readonly playback: ReadonlyMap<string, readonly Payload[]>;
  readonly basePacks?: readonly EnvCapability[];
  readonly config?: object;
}

/**
 * Re-run the whole program in a hermetic env whose ONLY membrane ops are playback
 * sources answering from the recorded payload stream, under a silent region (a
 * replay emits zero records). The live world is unreachable by construction: it is
 * simply not bound. A queue underflow is a teaching door (the replay diverged from
 * the recorded run, or the records are incomplete) — never a live re-fetch, never a
 * silent default.
 */
export async function replayProgramWithPlayback(opts: PlaybackReplayOptions): Promise<ReplayedValue> {
  const { source, playback, basePacks = [], config } = opts;
  return withSilentRegion(async () => {
    const base = await hermeticEnv(basePacks, "", {}, config);
    const frame = base.inherit("provenance-playback");
    for (const [op, payloads] of playback) {
      const queue = [...payloads];
      frame.defineRosetta(op, {
        fn: () => {
          const next = queue.shift();
          if (next === undefined) {
            throw new ReplayScopeError(
              "source",
              op,
              `playback queue for "${op}" underflowed — the replay demanded more penetrations than the record run crossed; the stream is incomplete or the program diverged (never answered live)`,
            );
          }
          return boxPayload(next);
        },
      });
    }
    const state = await execState(source, { env: frame, skipBootstrapWait: true });
    const boxed = state.values.at(-1);
    if (boxed === undefined) {
      throw new ReplayScopeError("port", "program", "the program evaluated zero forms — nothing to replay");
    }
    return { boxed, value: schemeToJs(boxed, {}) };
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Face 3 — effect-track replay-between-records.
// ─────────────────────────────────────────────────────────────────────────────

/** One step of an effect track's replay tape — either a recorded port event
 *  reproduced VERBATIM (the record + its frozen payload, authoritative) or a
 *  pure stretch's γ-applied value. The tape's order is the law's subject: it must
 *  equal the recorded stream's seq order with pure stretches interleaved between. */
export type ReplayStep =
  | { readonly kind: "port-event"; readonly record: MintRecord; readonly payload: Payload }
  | { readonly kind: "pure"; readonly value: unknown };

/** The pure stretch between two recorded events, as a wire: `accParam` receives
 *  the chained accumulator (`egress(Tᵢ) → ingress(Tᵢ₊₁)`, the ONE sanctioned
 *  inter-track edge), `eventParam` receives the verbatim recorded payload of the
 *  event the stretch follows. The stretch wire is CALLER-supplied (a law test
 *  lifts it from the recorded program's own accumulator body, or from the
 *  wireframe fan template's egress wire) — extracting it automatically from
 *  accumulator-role fan templates is the wireframe-walking driver's future job. */
export interface EffectStretch {
  readonly wire: EmittedWire;
  readonly accParam: string;
  readonly eventParam: string;
}

interface ReplayBetweenRecordsOptions {
  readonly store: ProvenanceStore;
  readonly payloads: PayloadStore;
  readonly regionId: RegionId;
  readonly stretch: EffectStretch;
  /** The chain's initial accumulator (boxed) — the fold's seed. */
  readonly initial: SchemeValue;
  readonly prelude?: string;
  readonly basePacks?: readonly EnvCapability[];
  readonly config?: object;
}

/**
 * Effect tracks replay in this mode — replay-between-records: pure stretches
 * applied, recorded port events interleaved verbatim.
 *
 *   1. fold.ts FIRST (composing the stream's own recovery law): the region must
 *      have COMPLETED (`pending === 0`) — replaying between the records of a
 *      region that never closed its tracks would fabricate an interleave the run
 *      never settled; the incomplete door's post-hoc mirror.
 *   2. the region's mint records IN SEQ ORDER are the verbatim port events — the
 *      stream's total order IS emission order; the interleave is read off it,
 *      never re-derived, never re-sorted by anything else.
 *   3. between consecutive events, the pure stretch is APPLIED (γ): the recorded
 *      event's payload (authoritative — the live world is never consulted) and
 *      the running accumulator feed the stretch wire; its egress chains into the
 *      next stretch. Neither pure-γ-only (the events are NOT recomputed) nor
 *      record-playback-only (the stretches are NOT stored — purity re-derives
 *      them), exactly this CHOSEN middle.
 */
export async function replayBetweenRecords(opts: ReplayBetweenRecordsOptions): Promise<{
  readonly steps: readonly ReplayStep[];
  readonly egress: unknown;
  readonly egressBoxed: SchemeValue;
}> {
  const { store, payloads, regionId, stretch, initial, prelude = "", basePacks = [], config } = opts;
  const stream = await store.readStream(regionId);
  const fold = foldRegionStream(stream);
  if (fold.pending !== 0) {
    throw new ReplayScopeError(
      "track",
      regionId,
      `region has ${fold.pending} pending track(s) (started ${fold.started}, completed ${fold.completed}) — replay-between-records only replays COMPLETED regions; close the region (or accept the incomplete door) first`,
    );
  }
  const mints = stream.filter((r): r is MintRecord => r.kind === "mint");

  return withSilentRegion(async () => {
    const base = await hermeticEnv(basePacks, prelude, {}, config);
    const steps: ReplayStep[] = [];
    let acc: SchemeValue = initial;
    for (const record of mints) {
      const payload = await payloads.get(record.payloadHash);
      const frozen: Payload = { value: payload.value, stampIds: payload.stampIds };
      // The event, VERBATIM — its payload is what crossed, not what would cross now.
      steps.push({ kind: "port-event", record, payload: frozen });
      // The pure stretch, APPLIED — γ over (acc, recorded payload).
      acc = await applyWireInEnv(base, stretch.wire, {
        [stretch.accParam]: acc,
        [stretch.eventParam]: boxPayload(frozen),
      });
      steps.push({ kind: "pure", value: schemeToJs(acc, {}) });
    }
    return { steps, egress: schemeToJs(acc, {}), egressBoxed: acc };
  });
}
