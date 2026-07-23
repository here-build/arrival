// degradation.ts — door-set degradation: the IMPLEMENTATION and domain types. Model (absent
// OPTIONAL enabling config narrows a capability's affected symbols to a cause-carrying DOOR-SET
// instead of silent withholding) is docs/environments.md §DEGRADATION. The `"forbid"` vs
// `"doors"` MODE distinction this model once carried is retired — TRAILS CLEANUP (Tier 1)
// found every build hardcoded `"forbid"` (D2 made the auto-door mint mode-independently) and
// zero readers of the mode anywhere — the auto-door mechanism below is now unconditional.
//
// Two failure classes are DELIBERATELY untouched — present-but-invalid config (schema.parse's own
// job, unconditional) and pack apply errors (a defect, never a door) STAY throw paths,
// unaffected by anything here.
//
// The degradable-set check is STRUCTURAL (`instanceof z.ZodOptional | z.ZodDefault`) — NOT zod's own
// `.isOptional()`, which a schema built from `z.custom()` with no predicate answers `true` for
// regardless of whether `.optional()` was ever called (verified against the installed zod:
// `z.object({ infer: z.custom<T>() }).parse({})` succeeds — a zod no-op-validator quirk, untouched
// here). The structural check keeps a genuinely-required-but-permissive key (infer's) OUT of the
// degradable set — required config always stays fail-closed — its absence invisible to this module,
// exactly as it is to today's `schema.parse` (a separate defect, not one this module should paper
// over by misclassifying it as optional).
//
// Vocabulary-facing surface: `DegradedCapability`/`DegradedNeed` are the shape
// `env/vocabulary.ts` folds (structurally, uninterpreted) into `Vocabulary.degraded` —
// defined HERE (the degradation-domain module) so the env-agnostic layers importing it
// stay decoupled from the vocabulary build itself. (Pre Stage-C Cut 3b, the kernel's now-
// retired `assembleEnv` folded the same shape into `AssembledEnv.degraded` instead.)
//
// DEPARTURE D2 (named, not silent — Stage 3, `Contract.requiresConfig` in
// `./symbols/_bake.js`): line 15's "required config always stays fail-closed" is about a key
// with NO `.optional()`/`.default()` wrapper — that stays a `schema.parse` throw, unconditional,
// unchanged. D2 is the ADDITIONAL, per-VERB case: a key a capability author wraps `.optional()`
// (so `schema.parse` succeeds absent) but names in some verb's `requiresConfig` is no longer
// "silently withheld, unless a builder hand-writes a `.door(...)` check" — `common/capability.ts`'s
// bind loop reads `requiresConfig` UNCONDITIONALLY and auto-mints the SAME `DoorCause` shape via
// `DegradationInfo.door` below. The two views agree by construction: a `requiresConfig`-named key
// is, by D2's own authoring rule, always `.optional()`/`.default()`-wrapped, so it is exactly the
// set `missingOptionalKeys` already reports — this module needed no new "is it optional" check,
// only a new, unconditional CALLER of the same `.door()` builder.

import { z } from "zod";
import type { DoorCause, DoorSymbolDef } from "./symbols/_bake.js";

/** One missing input a degraded door needs to become callable — the `configuration` kind is
 *  the shipped case (`DoorCause["needs"]`'s element shape, from `_bake.ts`); `dependency`/
 *  `resource` kinds stay deferred pending an unrooted-capability policy. */
export type DegradedNeed = DoorCause["needs"][number];

/** A capability-level entry on `Vocabulary.degraded` — an enumerable list a host/discovery
 *  reader inspects instead of inferring degradation from a throw or by probing symbols one
 *  by one. */
export interface DegradedCapability {
  readonly capability: string;
  readonly needs: readonly DegradedNeed[];
}

/** Declared-optional (`z.ZodOptional`/`z.ZodDefault` wrapper) keys of `shape` absent from
 *  `provided` (missing, or explicitly `undefined`). A key without one of those wrappers is
 *  NEVER reported here regardless of what its underlying validator happens to accept — see
 *  the file header's `z.custom()` note. `shape` is `CapabilitySpec.configuration` itself
 *  (the pre-`z.object()` `{key: ZodType}` record); `provided` is the raw `opts.config`
 *  bag `lower()` receives, un-parsed (parsing may reject it for a DIFFERENT reason —
 *  present-but-invalid — orthogonal to this scan). */
export function missingOptionalKeys(
  shape: Record<string, z.ZodTypeAny> | undefined,
  provided: Record<string, unknown> | undefined,
): string[] {
  if (shape === undefined) return [];
  const bag = provided ?? {};
  const missing: string[] = [];
  for (const [key, schema] of Object.entries(shape)) {
    if (bag[key] !== undefined) continue; // present — satisfied, regardless of optionality
    if (schema instanceof z.ZodOptional || schema instanceof z.ZodDefault) missing.push(key);
  }
  return missing;
}

/** The degradation view every `Activation` carries — a thin, owner-scoped `.door(...)`
 *  minter. Its ONE in-repo caller is the `requiresConfig` auto-door in `common/capability.ts`'s
 *  bind loop (the builder-form `symbols` arm that used to hand-mint doors off this interface is
 *  retired — a verb's config gate is declared as `Contract.requiresConfig`, loader's
 *  `require` being the worked example with its `[["fs", "loader"]]` any-of group). The
 *  interface used to also carry `mode`/`missingKeys`/`active` informational fields (from the
 *  now-retired `"forbid"` vs `"doors"` distinction — every capability build hardcoded `"forbid"`
 *  since D2 made the auto-door mint mode-independently); confirmed zero readers anywhere
 *  (internal or external), so the TRAILS CLEANUP (Tier 1) collapsed the surface to what's
 *  actually consulted. */
export interface DegradationInfo {
  /** Mint a `DoorSymbolDef` causally attributing `name` to THIS capability + `needs` (the
   *  causal chain end-to-end: reference → door → owner → missing key). Called by the
   *  `requiresConfig` auto-door; a pure value constructor, defined unconditionally. */
  door(name: string, needs: readonly string[], reason: string): DoorSymbolDef;
}

/** Build the `DegradationInfo` a capability's `Activation` carries — `owner` is the
 *  capability's own name (the `DoorCause.owner` every minted door stamps). */
export function buildDegradationInfo(owner: string): DegradationInfo {
  return {
    door: (name, needs, reason) => ({
      kind: "door",
      name,
      reason,
      cause: { owner, needs: needs.map((key) => ({ kind: "configuration" as const, key })) },
    }),
  };
}

/** Scan a lowered capability's own (already-computed) `symbolsRec` for degradation-minted
 *  doors — entries whose `cause.owner === capabilityName` and `cause.needs` is non-empty
 *  (a `notImplemented`-authored door with no cause, or one whose cause belongs to a
 *  DIFFERENT owner — a dep's door surfacing through re-export — is not THIS capability's
 *  degradation). Dedupes needs by `key` (a capability may mint several doors sharing the
 *  same missing key, e.g. `require`/`require/extension` both citing `fs`). Returns `undefined`
 *  when nothing degraded rather than an empty array, so `Vocabulary.degraded` never carries a
 *  needs-less, symbol-less entry. */
export function collectDegraded(
  capabilityName: string,
  symbolsRec: Record<string, DoorSymbolDef | unknown>,
): DegradedCapability | undefined {
  const seen = new Set<string>();
  const needs: DegradedNeed[] = [];
  for (const def of Object.values(symbolsRec)) {
    if (typeof def !== "object" || def === null || !("kind" in def) || (def as { kind: unknown }).kind !== "door")
      continue;
    const cause = (def as DoorSymbolDef).cause;
    if (cause?.owner !== capabilityName || cause.needs.length === 0) continue;
    for (const need of cause.needs) {
      const dedupeKey = `${need.kind}:${need.key}`;
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);
      needs.push(need);
    }
  }
  return needs.length === 0 ? undefined : { capability: capabilityName, needs };
}
