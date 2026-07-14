/**
 * typefacts — result shapes for the tsc→facts membrane (typefacts-extraction.md §2,
 * reconciled against the constitution §3.3/§5.3, which wins on conflict).
 *
 * `TypeFacts` itself is NOT defined here: the canonical vocabulary lives in
 * `@here.build/arrival/emit` (types-only, dependency-free — §4.5 layering), and
 * `EmitCtx.argFacts`/`selfFacts` consume it verbatim. Re-defining it here would
 * mint the exact adaptation layer spec §8 item 2 forbids. This module owns the
 * extraction-side shapes only: `HoleReason` (Gate-1's measurement instrument) and
 * the `FactsExtraction` envelope.
 */
import type { TypeFacts } from "@here.build/arrival/emit";

import type { ClassifyResult, NodeId } from "../coreform/index.js";

export type { TypeFacts } from "@here.build/arrival/emit";

/**
 * Why a node has no facts — Gate-1's measurement instrument (spec §7: the
 * type-availability corpus reads its histogram to decide which hole class the
 * types track attacks next).
 *
 * Taxonomy per spec §2, plus ONE owned extension (the spec assigns this component
 * the HoleReason taxonomy): `"ambiguous-span"` — the node's span carries several
 * exact mappings whose derived facts DISAGREE (a desugar-duplication shape).
 * Guessing a winner would be wrong-and-confident; Law F demands refusal, and the
 * histogram should show the refusal as its own class, not launder it as
 * "unmapped".
 */
export type HoleReason =
  | "unmapped-span" //   emitTypes recorded no mapping owned by this node (includes
  //                     a synthetic node's INHERITED span — the mapping belongs to
  //                     the outermost carrier, never the inheritor)
  | "dropped-form" //    the form's type-emit degraded to a placeholder (droppedForms)
  | "no-ts-node" //      offset mapped, but no TS node covers the mapped range
  | "any-or-unknown" //  type resolved to any/unknown/error — nothing provable
  | "probe-miss" //      arg-position Ref: own type unusable AND both instantiated-
  //                     signature probes returned nothing usable (spec §4 fallback)
  | "ambiguous-span" //  several exact mappings, divergent facts — refused (owned ext.)
  | "parse-failure"; //  whole-program: parseSexprs threw — no facts at all

export interface FactsExtraction {
  /** NodeId → proven facts. Absence of an id means "nothing provable" (Law F:
   *  every consumer must tolerate absence — a `{}` entry is never stored). */
  readonly facts: ReadonlyMap<NodeId, TypeFacts>;
  /** Per-QUERIED-node failure reasons. Structural derivations (Lit/Quote) never
   *  hole; a queried node with neither facts nor hole proved a type the closed
   *  vocabulary has nothing to say about (e.g. a plain dict object). */
  readonly holes: ReadonlyMap<NodeId, HoleReason>;
  /** Spec §6 E3: `parseSexprs` threw on the string path. No NodeIds exist to key
   *  holes by, so the maps are empty and this flag is the whole verdict — the
   *  compile proceeds guarded-everywhere (the front gate fails it first). */
  readonly parseFailure: boolean;
  /** The classified program the fact table keys into. On the string path the ids
   *  are minted HERE (per-classify, never stable across calls — coreform types.ts),
   *  so returning the classification is what makes the map consumable at all.
   *  `null` only under `parseFailure`. */
  readonly classified: ClassifyResult | null;
  /** The virtual TS the facts were read from — the cross-pass fixture's first
   *  column (constitution §5.3) and the debugging window. */
  readonly virtualTs: string;
}

export interface ExtractFactsOptions {
  /** Law-N witness KEY SET → type-emit's narrowing-form grammar (§5.3). Absent ⇒
   *  every condition wraps (Law F default) ⇒ flow types stay declared-wide. */
  readonly narrowsMembers?: ReadonlySet<string>;
  /** Host-injected ambient `__arr` member names — pass-through to emitTypes. */
  readonly hostMembers?: ReadonlySet<string>;
}

/** The classified-input form: reuse an existing classification (skip re-parse/
 *  re-classify) — `source` must be the exact text `classified` was built from
 *  (both sides key on byte spans into it; a mismatch degrades to holes, never to
 *  wrong facts). */
export interface ClassifiedSource {
  readonly source: string;
  readonly classified: ClassifyResult;
}

/** At least one positive claim. */
export const hasFacts = (f: TypeFacts): boolean => Object.keys(f).length > 0;
