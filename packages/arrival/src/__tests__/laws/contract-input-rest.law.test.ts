/**
 * LAW — a Contract with `inputRest` has a required positional prefix.
 *
 * Bake erases authored `input`/`inputRest` into one `in` vector: a ZodType rest
 * becomes `z.tuple(head, rest)`; a kwargs record becomes `z.object(shape)`.
 * The tuple's fixed items are the only prefix the rest can split on. An
 * `.optional()` / `.default()` slot there has no stable cut (the rest cannot
 * tell a missing prefix from the start of the tail). Kwargs field `.optional()`
 * is a different slot — the bag, not the prefix — and stays legal.
 *
 * Census is declaration-driven over BASE_PACKS (same seam as declared-doors):
 * `harvestContracts` → baked `.in`. No side registry. `.isOptional()` is not
 * the probe (`z.custom()` answers true with no predicate — degradation.ts);
 * `instanceof ZodOptional | ZodDefault` is. Optional without rest (make-list's
 * fill) is a different shape and must stay legal.
 *
 * Builder-form `symbols` cannot be enumerated statically and is skipped — no
 * base pack uses it.
 */
import { describe, expect, it } from "vitest";
import { ZodDefault, ZodOptional, type ZodTypeAny } from "zod";
import * as z from "../../common/scheme-zod/index.js";
import { BASE_PACKS } from "../../env/base-packs.js";
import { harvestContracts } from "../_symbols-harvest.js";
import type { AEntity } from "../../common/symbols/_bake.js";

function bakedIn(entity: AEntity): ZodTypeAny | undefined {
  return "in" in entity ? entity.in : undefined;
}

function tupleWithRest(schema: ZodTypeAny): { items: readonly ZodTypeAny[] } | undefined {
  const def = z.defOf(schema) as { type?: string; items?: readonly ZodTypeAny[]; rest?: ZodTypeAny } | undefined;
  if (def?.type !== "tuple" || def.rest == null) return undefined;
  return { items: def.items ?? [] };
}

function isOmittable(slot: ZodTypeAny): boolean {
  return slot instanceof ZodOptional || slot instanceof ZodDefault;
}

function census(): {
  restContracts: number;
  optionalWithoutRest: number;
  omittablePrefix: readonly string[];
} {
  let restContracts = 0;
  let optionalWithoutRest = 0;
  const omittablePrefix: string[] = [];
  for (const cap of BASE_PACKS) {
    const symbols = cap.spec.symbols;
    if (symbols === undefined || typeof symbols === "function") continue;
    for (const [name, entity] of Object.entries(harvestContracts(symbols))) {
      const input = bakedIn(entity);
      if (input === undefined) continue;
      const rest = tupleWithRest(input);
      if (rest === undefined) {
        const def = z.defOf(input) as { type?: string; items?: readonly ZodTypeAny[] } | undefined;
        if (def?.type === "tuple" && (def.items ?? []).some(isOmittable)) optionalWithoutRest += 1;
        continue;
      }
      restContracts += 1;
      rest.items.forEach((slot, i) => {
        if (isOmittable(slot)) {
          omittablePrefix.push(`${cap.name}/${name} prefix[${i}]`);
        }
      });
    }
  }
  return { restContracts, optionalWithoutRest, omittablePrefix };
}

const CENSUS = census();

describe("Contract inputRest — required prefix (declaration-driven over BASE_PACKS)", () => {
  it("the census is not vacuous — rest contracts exist, and optional-without-rest exists so the probe is live", () => {
    expect(CENSUS.restContracts).toBeGreaterThan(0);
    expect(CENSUS.optionalWithoutRest).toBeGreaterThan(0);
  });

  it("no inputRest prefix slot is optional or defaulted", () => {
    expect(CENSUS.omittablePrefix).toEqual([]);
  });
});
