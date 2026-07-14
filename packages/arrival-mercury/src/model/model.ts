/**
 * SchemeSemanticModel — the class skeleton. E0-RED STATE: every spine member
 * throws `Unimplemented`; the red suite (`__tests__/model-spine.test.ts`)
 * pins the design as `it.fails` rows that un-red one by one as views land
 * (the corpus's self-firing promote convention).
 *
 * v1 constructor takes (source, registry): the capability composition is
 * already harvested into an EmitRegistry everywhere this package works; the
 * full `(source, capabilities)` constructor lands with the interpreter
 * wiring phase (`interpreter.run(model, …)`), when the model re-homes toward
 * arrival core.
 */
import type { ClassifyResult, CoreForm, NodeId } from "../coreform/types.js";
import { classify } from "../coreform/classify.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import type { EmitRegistry } from "../registry/harvest.js";
import type {
  Anchor,
  AnchorPort,
  Chain,
  ChainProgram,
  DemandGraph,
  EdgeKey,
  RunnableSlice,
  Transfer,
  WireUneval,
} from "./types.js";

/** Thrown by every not-yet-landed view — the red suite's expected signal. */
export class Unimplemented extends Error {
  constructor(view: string) {
    super(`SchemeSemanticModel.${view}: unimplemented (E0 red state — see model-spine.test.ts)`);
    this.name = "Unimplemented";
  }
}

export class SchemeSemanticModel {
  readonly source: string;
  readonly registry: EmitRegistry;

  /** Stratum 0 — already-landed machinery, wrapped (the one green part of E0-red). */
  readonly coreform: ClassifyResult;

  constructor(source: string, registry: EmitRegistry) {
    this.source = source;
    this.registry = registry;
    this.coreform = classify(desugar(parseSexprs(source)));
  }

  nodeAt(_offset: number): CoreForm | undefined {
    throw new Unimplemented("nodeAt");
  }

  // ── the spine ──────────────────────────────────────────────────────────

  get anchors(): readonly Anchor[] {
    throw new Unimplemented("anchors");
  }

  get chains(): readonly Chain[] {
    throw new Unimplemented("chains");
  }

  chainFeeding(_input: AnchorPort): Chain {
    throw new Unimplemented("chainFeeding");
  }

  get demandGraph(): DemandGraph {
    throw new Unimplemented("demandGraph");
  }

  programOf(_chain: Chain): ChainProgram {
    throw new Unimplemented("programOf");
  }

  sliceOf(_chain: Chain): RunnableSlice {
    throw new Unimplemented("sliceOf");
  }

  transferOf(_chain: Chain): Transfer {
    throw new Unimplemented("transferOf");
  }

  unevalOf(_chain: Chain): WireUneval {
    throw new Unimplemented("unevalOf");
  }

  get wireMap(): ReadonlyMap<EdgeKey, readonly WireUneval[]> {
    throw new Unimplemented("wireMap");
  }
}
