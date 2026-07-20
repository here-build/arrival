// metadata — the READ-time resolver for a symbol's `metadata` extension bag. One small
// pure helper, the ONE place the per-field static-or-dynamic union (`MetadataField`,
// ./_bake.ts) is interpreted, and the CANONICAL HOME for the describe-time read channel
// contract every metadata-carrying kind points back to. docs/ASSEMBLY.md §DESCRIBE-TIME
// gives the channel-level view and names this file as that home; the three rulings live
// here in full.
//
// DESCRIBE-TIME READ CHANNEL:
// A dynamic (fn-valued) metadata field resolves LAZILY at describe/catalog READ time,
// against the assembly's phase-2 activation — never at bake/lower. The three rulings this
// resolver implements:
//   1. LAZILY AT READ, against the phase-2 activation. A dynamic field touching
//      `this.resources.x.live` spawns the resource on FIRST READ through the cell's normal
//      lazy single-flight — that is correct (the welcome screen genuinely reads the
//      dashboard's ports); resolving at assembly would be the connection storm the
//      worker-ephemerality ruling forbids.
//   2. PER-READ, NO MEMO — matches the shipped McpAnnotation semantics (the thunk fires
//      on every catalog fetch) and the ephemerality doctrine (a memo is a cache with no
//      invalidation story). An expensive field's author memoizes inside the fn and owns
//      the staleness contract.
//   3. `undefined` RESOLUTION = fall back to the static sibling, NOT flagged dynamic —
//      preserves McpAnnotation's honest-failure contract (a failed live fetch returns
//      `undefined`; the consumer shows the static `description` and does NOT claim
//      session-generation). Here: the key is OMITTED from `resolved` and absent from
//      `dynamicKeys`.
//
// PROVENANCE: metadata reads are describe-time host-side IO, outside every wire — no
// provenance node, nothing enters a record stream. Scheme programs never see metadata (no
// `(symbol-metadata …)` verb — same law as no `(configuration :key)`).

import type { Activation } from "../capability.js";
import type { MetadataRecord } from "./_bake.js";

/** The result of one metadata read: the resolved record (static fields verbatim, dynamic
 *  fields' resolved values; `undefined`-resolving dynamic fields omitted) plus which keys
 *  actually resolved dynamically — the consumer's "session-generated" flag source. */
export interface ResolvedMetadata {
  readonly resolved: Record<string, unknown>;
  readonly dynamicKeys: readonly string[];
}

/** Resolve every fn-valued field against the activation; report which were dynamic.
 *  The discriminant is `typeof === "function"` (a static field can never BE a function —
 *  see `MetadataField`). A throwing dynamic field propagates — honest failure is the
 *  author returning `undefined`, not this helper swallowing errors. */
export async function resolveMetadata(
  metadata: MetadataRecord | undefined,
  activation: Activation<any, any>,
): Promise<ResolvedMetadata> {
  const resolved: Record<string, unknown> = {};
  const dynamicKeys: string[] = [];
  if (metadata === undefined) return { resolved, dynamicKeys };
  for (const [key, field] of Object.entries(metadata)) {
    if (typeof field === "function") {
      const value = await (field as (this: Activation<any, any>) => unknown).call(activation);
      if (value !== undefined) {
        resolved[key] = value;
        dynamicKeys.push(key); // resolved dynamically — flag it
      }
      // undefined ⇒ ruling 3: omit the key, do NOT flag dynamic (static-sibling fallback
      // is the CONSUMER's move — this record simply doesn't claim the field).
    } else {
      resolved[key] = field; // STATIC — data, verbatim
    }
  }
  return { resolved, dynamicKeys };
}

/** The STATIC subset of a metadata bag — total at module load, zero assembly needed (the
 *  enumerability property that keeps the static subset readable pre-assembly, made
 *  callable). Fn-valued (dynamic) fields are simply absent. */
export function staticMetadata(metadata: MetadataRecord | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(metadata ?? {}).filter(([, v]) => typeof v !== "function"));
}
