// control-symbol-define-migration.test.ts — W4-H2 pack-migration law rows for
// `scheme/r7rs/control` (docs/working-proposals/symbol-define-static-program-
// validation.md §1/§2.1/§3.3b/§4.2).
//
// This pack is the narrowest possible migration case, narrower even than H1's
// binding.ts (which at least had two `define-syntax` macros): control.ts's ENTIRE
// symbol population is `symbol.notImplemented` DOORS — zero `symbol.define`,
// zero `symbol.defineSyntax`, and (verified) it never carried a `prelude` field
// to begin with. The census (§4.1) lists "23 production EnvCapability preludes"
// and r7rs/control is NOT among them (grep-verified: `grep -rln "prelude:" src/env/`
// does not return this file) — Pass 1 (mechanical decomposition) and Pass 2
// (contract authoring) both have NOTHING to run over. What DOES apply, one row
// each, mirroring the wave's per-pack template narrowed to what's actually here:
//
//   ROW 1 — structural: no prelude field; all 10 symbols are kind "door"; a door
//     carries no contract surface (§1.1/§1.2 apply only to `symbol.define`).
//   ROW 2 — bake / cause stamping: `.lower({})` succeeds with zero deps (this
//     pack references nothing outside itself); every bound value is a
//     `DoorProcedure` whose `.door.cause` was stamped by capability.ts's door
//     bind arm (`{owner: "scheme/r7rs/control", needs: []}` — a permanent design
//     omission, never a door-set-degradation door, §3.7).
//   ROW 3 — contract teaching: firing a door throws the teaching `PurityError`,
//     `name @ owner` display discipline (§3.1), reason text unchanged from the
//     pre-migration doors (this pack was NEVER migrated in the byte sense — this
//     row pins that the doors' teaching text is untouched by the wave).
//   ROW 4 — FV law: N/A structurally, asserted as a negative (mirrors binding's
//     ROW 2 and srfi-26's ROW 3): `define-bake.ts`'s §2.1 FV check only walks
//     `kind === "define"` bodies, and this pack has none — `lower({})` cannot
//     throw `DefineLocalityError`/`DefineForwardReferenceError`/
//     `ProvenanceRoleShapeError` because nothing here is FV-walked at all.
//     `exports()` (§2.2) still derives the correct 10-name surface purely from
//     `spec.symbols` keys (the `macroAwareDefineNames(spec.prelude)` half of the
//     union is vacuous — no prelude to parse).
//   ROW 5 — the §6.10 boundary check the task names explicitly: `map`/`for-each`
//     (R7RS §6.10 control features) do NOT live in this pack — they are
//     `symbol.native` entries in `r7rs/lists.ts` with real (already-enforced,
//     pre-existing) contracts. `call-with-values`/`values` (also §6.10) live in
//     `r7rs/binding.ts`. This pack owns exactly the SUBSET of §6.10/§4.2.5/§4.2.6
//     arrival omits by design (call/cc, dynamic-wind, make-parameter,
//     parameterize, delay, force, make-promise, delay-force, promise?) — ten
//     names, no more, no less (promise? doored W4-H4: with every promise
//     constructor doored, no promise value exists for it to recognize).
//   ROW 6 — chibi conformance cross-check: every door this pack declares is
//     covered by a `registries.ts` Exclusion `anyOf` rule (two of which cite
//     "r7rs/control.ts's notImplemented doors" by name in their `feature` text) —
//     an anti-drift pin so a door added/removed here without a matching registry
//     update fails LOUDLY here rather than silently under-covering/over-covering
//     the conformance ledger's 651-EXACT gate.
import { describe, expect, it } from "vitest";
import controlPack from "../control.js";
import { EXCLUDED } from "../../../__tests__/chibi/registries.js";
import { PurityError } from "../../../errors.js";
import { DefineForwardReferenceError, DefineLocalityError, ProvenanceRoleShapeError } from "../../../errors.js";
import { DoorProcedure } from "../../../values/primitives/ACallable.js";
import { freshEnv } from "../../../__tests__/_fresh-env.js";
import type { AEntity, DoorSymbolDef } from "../../../common/symbol.js";

const symbols = controlPack.spec.symbols as Record<string, AEntity>;

// The pack's exact door population, name-for-name — every ROW below is scoped to
// precisely this set so a future addition/removal is forced through every row.
const DOOR_NAMES = [
  "call/cc",
  "call-with-current-continuation",
  "dynamic-wind",
  "make-parameter",
  "parameterize",
  "delay",
  "force",
  "make-promise",
  "delay-force",
  "promise?",
] as const;

function doorDef(name: string): DoorSymbolDef {
  const def = symbols[name];
  if (def === undefined) throw new Error(`control pack: no symbol named ${name}`);
  if (def.kind !== "door") throw new Error(`control pack: ${name} is not a door def (got ${def.kind})`);
  return def;
}

describe("ROW 1 — structural: no prelude, every symbol is a contract-free door", () => {
  it("the capability declares no prelude field", () => {
    expect(controlPack.spec.prelude).toBeUndefined();
  });

  it("the capability's symbol population is EXACTLY the ten documented omissions", () => {
    expect(Object.keys(symbols).sort()).toEqual([...DOOR_NAMES].sort());
  });

  it("every symbol is kind: door", () => {
    for (const name of DOOR_NAMES) {
      expect(doorDef(name).kind).toBe("door");
    }
  });

  it("a door carries no contract surface (§1.1/§1.2 are symbol.define-only)", () => {
    for (const name of DOOR_NAMES) {
      const def = doorDef(name);
      expect("in" in def).toBe(false);
      expect("out" in def).toBe(false);
      expect("callable" in def).toBe(false);
      expect("validate" in def).toBe(false);
      expect("body" in def).toBe(false);
      expect("bodyHash" in def).toBe(false);
    }
  });

  it("every door has a non-empty teaching reason", () => {
    for (const name of DOOR_NAMES) {
      expect(doorDef(name).reason.length).toBeGreaterThan(20);
    }
  });
});

describe("ROW 2 — bake / cause stamping: lower() succeeds, doors bind with a stamped owner", () => {
  it("a bare lower({}) — zero deps, zero config — does not throw", () => {
    expect(() => controlPack.lower({})).not.toThrow();
  });

  it("every bound value is a DoorProcedure carrying cause {owner: 'scheme/r7rs/control', needs: []}", async () => {
    const env = await freshEnv();
    for (const name of DOOR_NAMES) {
      const bound = env.get(name);
      expect(bound).toBeInstanceOf(DoorProcedure);
      const proc = bound as DoorProcedure;
      expect(proc.door.cause?.owner).toBe("scheme/r7rs/control");
      expect(proc.door.cause?.needs).toEqual([]);
    }
  });
});

describe("ROW 3 — contract teaching: firing a door throws the name@owner PurityError", () => {
  it.each(DOOR_NAMES)("%s throws PurityError naming itself and its owning capability", async (name) => {
    const env = await freshEnv();
    const bound = env.get(name) as DoorProcedure;
    let caught: unknown;
    try {
      bound["arrival/tagless-final/apply"]();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PurityError);
    const err = caught as PurityError;
    expect(err.owner).toBe("scheme/r7rs/control");
    expect(err.feature).toBe(name);
    // §3.1 display discipline: `name @ owner`, never a bare/hash identity.
    expect(err.message).toContain(`${name} @ scheme/r7rs/control`);
  });
});

describe("ROW 4 — FV law: N/A structurally (no symbol.define body exists to walk)", () => {
  it("lower({}) never throws the §2.1 bake FV errors — nothing here is FV-checked", () => {
    // define-bake.ts's FV/locality/forward-reference/role-shape checks only run
    // for `kind === "define"` entries; this pack has none, so these errors are
    // structurally unreachable — asserted as a negative, mirroring srfi-26's
    // ROW 3 and binding's ROW 2.
    let caught: unknown;
    try {
      controlPack.lower({});
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeUndefined();
    expect(caught).not.toBeInstanceOf(DefineLocalityError);
    expect(caught).not.toBeInstanceOf(DefineForwardReferenceError);
    expect(caught).not.toBeInstanceOf(ProvenanceRoleShapeError);
  });

  it("exports() derives exactly the door-name surface from spec.symbols alone (the prelude half of the union is vacuous)", async () => {
    const exported = await controlPack.exports();
    expect([...exported].sort()).toEqual([...DOOR_NAMES].sort());
  });
});

describe("ROW 5 — §6.10 boundary: map/for-each/values/call-with-values live OUTSIDE this pack", () => {
  it("this pack does not declare map/for-each/values/call-with-values", () => {
    for (const name of ["map", "for-each", "string-map", "vector-map", "string-for-each", "vector-for-each", "values", "call-with-values"]) {
      expect(symbols[name]).toBeUndefined();
    }
  });

  it("map/for-each resolve as symbol.native (already-contracted) in the assembled base env, not as doors from this pack", async () => {
    const env = await freshEnv();
    for (const name of ["map", "for-each"]) {
      const bound = env.get(name);
      expect(bound).toBeDefined();
      expect(bound).not.toBeInstanceOf(DoorProcedure);
    }
  });

  it("call-with-values/values resolve as symbol.native from r7rs/binding, not as doors from this pack", async () => {
    const env = await freshEnv();
    for (const name of ["call-with-values", "values"]) {
      const bound = env.get(name);
      expect(bound).toBeDefined();
      expect(bound).not.toBeInstanceOf(DoorProcedure);
    }
  });
});

describe("ROW 6 — chibi conformance cross-check: every door is covered by a registries.ts Exclusion", () => {
  function coveredBySomeRule(name: string): boolean {
    return EXCLUDED.some((rule) => rule.match.kind === "symbols" && rule.match.anyOf.includes(name));
  }

  it.each(DOOR_NAMES)("%s is named in at least one EXCLUDED symbols rule", (name) => {
    expect(coveredBySomeRule(name)).toBe(true);
  });

  it("the two feature texts that cite this file by name still do (anti-drift pin on the cross-reference itself)", () => {
    const featuresWithSelfCitation = EXCLUDED.filter(
      (rule) => rule.match.kind === "symbols" && rule.feature.includes("r7rs/control.ts"),
    );
    expect(featuresWithSelfCitation.length).toBeGreaterThanOrEqual(2);
  });
});
