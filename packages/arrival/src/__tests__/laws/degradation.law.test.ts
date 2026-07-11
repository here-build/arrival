/**
 * degradation.law.test.ts — door-set degradation (W2 of docs/working-proposals/
 * symbol-define-static-program-validation.md §3.7). W0 (commit 98641484b3) shipped the
 * introspectable `DoorProcedure` + `DoorCause` shape with `needs: []` stamped everywhere;
 * this law suite pins the W2 MECHANISM that actually mints non-empty `needs` — the
 * `degradation:` mode knob on `EnvCapability.lower()`, `Activation.degradation`
 * (common/degradation.ts), and `AssembledEnv.degraded` (common/kernel.ts).
 *
 * LAW 1 ("forbid" default preserved): a genuinely REQUIRED config key (no `.optional()`/
 *   `.default()`) absent from the supplied config throws at `lower()` REGARDLESS of
 *   `degradation` mode — §3.7's "required config stays fail-closed" row is unconditional,
 *   not mode-gated. Present-but-INVALID config throws the same way (LAW 4).
 *
 *   Deviation from the ticket's literal fixture, recorded honestly: `arrival/infer`'s own
 *   `configuration: { infer: z.custom<InferFn>() }` was named as "the non-optional key"
 *   fixture, but verified against the installed zod (4.3.6): `z.custom()` with NO predicate
 *   answers `.isOptional()` `true` and `schema.parse({})` SUCCEEDS — infer's config is a
 *   known no-op validator (design doc §8 decision item 9, explicitly out of THIS wave's
 *   scope), so it does not actually throw today, mode or no mode. Asserting a throw against
 *   it would pin a falsehood. This suite instead (a) proves a REAL required key throws, and
 *   (b) proves `missingOptionalKeys` correctly refuses to classify infer's shape as
 *   "optional" — the structural check (`instanceof ZodOptional | ZodDefault`) that keeps
 *   this module from silently degrading a key the author never marked `.optional()`.
 *
 * LAW 2 ("doors" mode lowers to a cause-carrying door-set): an absent OPTIONAL enabling key
 *   consulted via `Activation.degradation` binds a `DoorProcedure` whose firing message
 *   teaches "provide X to enable it" — never a silent withhold.
 *
 * LAW 3 (degraded list surfaced): `AssembledEnv.degraded` enumerates every capability that
 *   lowered degraded (capability name + the missing `needs`); empty under `"forbid"` (the
 *   default — no capability's `.active` is ever true there).
 *
 * LAW 4 (invalid config still throws in BOTH modes): present-but-wrong-shaped config is a
 *   `schema.parse` throw unconditionally — degradation only ever narrows ABSENCE.
 *
 * LAW 5 (doors are typo-suggestible + carry the causal chain): a degradation-minted door is
 *   an ordinary bound value — present in `env.allBoundNames()` (the exact iterable
 *   `suggestFromVocabulary`'s callers feed it, per unbound-variable.ts's own doc), so it
 *   participates in typo suggestion for free (W0's own finding, now true of MINTED doors
 *   too, not just authored `notImplemented` ones). Firing it reconstructs the full causal
 *   chain: reference → door (`.door`) → owner (`.cause.owner`) → missing key (`.cause.needs`).
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";
// The SCHEME-facing contract vocabulary (`sz.value`, the `symbol.native` input/output
// vectors) is a DIFFERENT module than JS `zod` (config schemas use real `zod`) — aliased
// so both are usable in the same file without shadowing, matching every other test that
// declares both a capability's `configuration` (JS zod) and a native's contract (scheme-zod).
import * as sz from "../../common/scheme-zod.js";

import { EnvCapability, type SymbolDeclaration } from "../../common/capability.js";
import { assembleEnv } from "../../common/kernel.js";
import { missingOptionalKeys } from "../../common/degradation.js";
import { symbol } from "../../common/symbol.js";
import { DoorProcedure } from "../../values/primitives/ACallable.js";
import { PurityError } from "../../errors.js";
import { nil } from "../../index.js";
// In-package test: internal-module access (the barrel export retired — privatization V5).
import { inferenceEnv as sandboxedEnv } from "../../inference-env.js";
import type { ResolverSpec, SchemeEnv } from "../../common/scheme-env.js";

/** A minimal recording SchemeEnv — same shape as door-cause.test.ts's, local here so this
 *  law suite has no cross-file coupling to another test's fixture. */
function recordingEnv(): { env: SchemeEnv; bound: Map<string, unknown> } {
  const bound = new Map<string, unknown>();
  const unrecordable = (verb: string) => new Error(`recordingEnv: ${verb} is not recordable`);
  const env: SchemeEnv = {
    set: (name, value) => {
      bound.set(name, value);
      return value;
    },
    get: (name) => bound.get(name),
    inherit: () => env,
    registerResolver: (_r: ResolverSpec) => {
      throw unrecordable("registerResolver");
    },
    list: () => [...bound.keys()],
    allBoundNames: () => [...bound.keys()],
  };
  return { env, bound };
}

// ============================================================================
// LAW 1 + LAW 4 — throw paths stay throw paths, unconditionally
// ============================================================================

describe("LAW 1 — required-and-absent config throws regardless of degradation mode", () => {
  const requiredCap = () =>
    new EnvCapability("test/degradation-required", {
      configuration: { must: z.string() },
      symbols: { stub: symbol.notImplemented`stub: unreachable — config validation throws first` },
    });

  it("throws under the default ('forbid') mode", () => {
    expect(() => requiredCap().lower({ config: {} })).toThrow();
  });

  it("throws just the same under 'doors' — required config is NEVER mode-gated", () => {
    expect(() => requiredCap().lower({ config: {}, degradation: "doors" })).toThrow();
  });

  it("missingOptionalKeys correctly EXCLUDES a bare z.custom() key (arrival/infer's shape) — structural, not behavioral", () => {
    // Mirrors arrival/infer's `configuration: { infer: z.custom<InferFn>() }` exactly: no
    // `.optional()` call. Verified: zod's OWN `.isOptional()` answers `true` for this shape
    // regardless (a permissive-validator artifact, not a declared-optional fact) — this
    // module's structural check must NOT be fooled by that into treating a required-looking
    // key as degradable.
    const shape = { infer: z.custom<() => unknown>() };
    expect(shape.infer.isOptional()).toBe(true); // the zod quirk, pinned so a zod upgrade that changes it is caught here
    expect(missingOptionalKeys(shape, {})).toEqual([]); // NOT reported — this module isn't fooled
  });
});

describe("LAW 4 — present-but-invalid config throws in BOTH modes (degradation only narrows ABSENCE)", () => {
  // Widened to `EnvCapability<any, any>` (the same declared-type idiom
  // arrival's src/loader/loader-capability.ts uses) so the WRONG-SHAPED config this
  // test deliberately supplies type-checks without a cast — the runtime `schema.parse`
  // throw is the thing under test, not TS's own config-shape guard.
  const invalidCap = (): EnvCapability<any, any> =>
    new EnvCapability("test/degradation-invalid", {
      configuration: { n: z.number() },
      symbols: { stub: symbol.notImplemented`stub: unreachable — config validation throws first` },
    });

  it("throws under 'forbid'", () => {
    expect(() => invalidCap().lower({ config: { n: "not-a-number" } })).toThrow();
  });

  it("throws under 'doors' too", () => {
    expect(() => invalidCap().lower({ config: { n: "not-a-number" }, degradation: "doors" })).toThrow();
  });
});

// ============================================================================
// LAW 2 + LAW 3 — the degradation mechanism itself
// ============================================================================

/** A small fixture with ONE optional-enabling key, mirroring `arrival/loader`'s `fs` shape
 *  (a real predicate + `.optional()`) closely enough to exercise the mechanism without
 *  depending on the (downstream, cross-package) real loader capability. */
function fixtureCapability(name: string): EnvCapability<any, any> {
  return new EnvCapability(name, {
    configuration: {
      fs: z
        .custom<{ readFile: (p: string) => Promise<string> }>(
          (v): v is { readFile: (p: string) => Promise<string> } =>
            v !== null && typeof v === "object" && typeof (v as { readFile?: unknown }).readFile === "function",
          "fs must expose readFile(path)",
        )
        .optional(),
    },
    symbols: ({ configuration, degradation }) => {
      const defs: Record<string, SymbolDeclaration> = {};
      if (configuration.fs !== undefined) {
        defs["fixture/verb"] = symbol.native`fixture/verb: reads via the fs`({ input: [], output: [sz.value] }, () => nil);
      } else if (degradation.active) {
        defs["fixture/verb"] = degradation.door(
          "fixture/verb",
          ["fs"],
          'reads via a filesystem this capability was not given. Provide "fs" to enable it.',
        );
      }
      return defs;
    },
  });
}

describe("LAW 2 — 'doors' mode lowers an absent optional-enabling key to a cause-carrying door", () => {
  it("under the default ('forbid') mode, the key stays withheld — no symbol at all (byte-identical to pre-W2)", async () => {
    const { env, bound } = recordingEnv();
    await fixtureCapability("test/degradation-fixture-forbid").lower({ config: {} }).apply(env, undefined as never);
    expect(bound.has("fixture/verb")).toBe(false);
  });

  it("under 'doors', the symbol BINDS as a door whose firing message teaches 'provide fs to enable it'", async () => {
    const { env, bound } = recordingEnv();
    await fixtureCapability("test/degradation-fixture-doors").lower({ config: {}, degradation: "doors" }).apply(env, undefined as never);
    const proc = bound.get("fixture/verb");
    expect(proc).toBeInstanceOf(DoorProcedure);
    let caught: unknown;
    try {
      (proc as DoorProcedure)["arrival/tagless-final/apply"]();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PurityError);
    const err = caught as PurityError;
    expect(err.message).toBe(
      'fixture/verb @ test/degradation-fixture-doors is not available.\n  Why: reads via a filesystem this capability was not given. Provide "fs" to enable it.',
    );
    expect(err.owner).toBe("test/degradation-fixture-doors");
  });

  it("a SATISFIED config binds the real verb, not a door, even under 'doors' mode", async () => {
    const { env, bound } = recordingEnv();
    await fixtureCapability("test/degradation-fixture-satisfied")
      .lower({ config: { fs: { readFile: async () => "" } }, degradation: "doors" })
      .apply(env, undefined as never);
    expect(bound.get("fixture/verb")).not.toBeInstanceOf(DoorProcedure);
  });
});

describe("LAW 3 — AssembledEnv.degraded enumerates every degraded capability", () => {
  it("is empty under the default ('forbid') mode", async () => {
    const base = sandboxedEnv.inherit("degradation-law-forbid");
    const assembled = await assembleEnv(base, [fixtureCapability("test/degradation-assembled-forbid").lower({ config: {} })]);
    expect(assembled.degraded).toEqual([]);
  });

  it("carries {capability, needs} for a capability that lowered degraded under 'doors'", async () => {
    const base = sandboxedEnv.inherit("degradation-law-doors");
    const assembled = await assembleEnv(base, [
      fixtureCapability("test/degradation-assembled-doors").lower({ config: {}, degradation: "doors" }),
    ]);
    expect(assembled.degraded).toEqual([
      { capability: "test/degradation-assembled-doors", needs: [{ kind: "configuration", key: "fs" }] },
    ]);
  });

  it("stays empty when the config is satisfied, even under 'doors' mode (nothing degraded)", async () => {
    const base = sandboxedEnv.inherit("degradation-law-satisfied");
    const assembled = await assembleEnv(base, [
      fixtureCapability("test/degradation-assembled-satisfied").lower({
        config: { fs: { readFile: async () => "" } },
        degradation: "doors",
      }),
    ]);
    expect(assembled.degraded).toEqual([]);
  });
});

// ============================================================================
// LAW 5 — the causal chain end-to-end, and typo-suggestibility
// ============================================================================

describe("LAW 5 — a degradation-minted door is bound (typo-suggestible) and carries the full causal chain", () => {
  it("appears in allBoundNames() — the exact vocabulary suggestFromVocabulary's callers feed it (unbound-variable.ts)", async () => {
    const { env, bound } = recordingEnv();
    await fixtureCapability("test/degradation-suggestible").lower({ config: {}, degradation: "doors" }).apply(env, undefined as never);
    expect(env.allBoundNames()).toContain("fixture/verb");
    expect(bound.get("fixture/verb")).toBeInstanceOf(DoorProcedure);
  });

  it("reference → door → owner → missing key: the whole chain reads off the bound value", async () => {
    const { env, bound } = recordingEnv();
    await fixtureCapability("test/degradation-causal-chain").lower({ config: {}, degradation: "doors" }).apply(env, undefined as never);
    // "reference": a lookup by name, exactly what a program's free-variable reference resolves to.
    const referenced = env.get("fixture/verb");
    expect(referenced).toBe(bound.get("fixture/verb"));
    // "door": the introspectable DoorSymbolDef.
    const door = (referenced as DoorProcedure).door;
    expect(door.kind).toBe("door");
    // "owner": the capability that minted it.
    expect(door.cause?.owner).toBe("test/degradation-causal-chain");
    // "missing key": the configuration entry that would satisfy it.
    expect(door.cause?.needs).toEqual([{ kind: "configuration", key: "fs" }]);
  });
});
