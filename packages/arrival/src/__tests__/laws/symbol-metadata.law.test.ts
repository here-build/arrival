/**
 * LAW — dynamic symbol METADATA (exec-phases-and-dynamic-metadata.md Part II).
 * The per-FIELD static-or-dynamic union + the three §2.3 resolution rulings:
 *
 *   1. LAZY AT READ — `lower()`/`assembleAmbient()` NEVER invoke a metadata fn (not to
 *      validate, not to warm); resolution happens per describe/catalog read against the
 *      phase-2 activation. A field touching a resource spawns it on FIRST READ through
 *      the cell's normal lazy single-flight — a metadata read IS a first touch.
 *   2. PER-READ, NO MEMO — every read re-fires the fn (the shipped McpAnnotation
 *      cadence; a memo is a cache with no invalidation story).
 *   3. `undefined` RESOLUTION — the key is omitted, NOT flagged dynamic (the honest-
 *      failure contract: the consumer falls back to the static sibling).
 *
 * Plus: the factory stamping (rosetta's `opts.metadata` reaches the def — the drop this
 * design closed), the `typeof === "function"` discriminant, and the §2.1 static-subset
 * enumerability (zero assembly).
 */
import { describe, expect, it } from "vitest";

import { z as hostZod } from "zod";

import { EnvCapability, type Activation } from "../../common/capability.js";
import type { Resource } from "../../common/resources.js";
import * as z from "../../common/scheme-zod.js";
import {
  resolveMetadata,
  staticMetadata,
  symbol,
  type NativeSymbolDef,
  type RosettaSymbolDef,
} from "../../common/symbol.js";
import { assembleAmbient } from "../../eval/generator-exec.js";

const zz = { string: z.string, number: z.number };

/** Test-only cast — see symbol.test.ts's own copy of this helper for the full rationale
 *  (Stage A2: `symbol.native`/`symbol.rosetta` mint the value directly; the metadata bag
 *  rides `.contract` on it). */
function contractOf<T>(v: { contract: unknown }): T {
  return v.contract as T;
}

describe("factory stamping — the metadata bag reaches the def (the closed drop)", () => {
  it("symbol.rosetta stamps opts.metadata onto the def; dynamic fields stay UN-invoked at bake", () => {
    let fired = 0;
    const def = symbol.rosetta`law/meta: doc line`({ input: [], output: [zz.string] }, () => "v", {
      metadata: {
        description: "static text",
        dynamicDescription: function () {
          fired += 1;
          return "live";
        },
      },
    });
    expect(contractOf<RosettaSymbolDef>(def).metadata?.description).toBe("static text");
    expect(typeof contractOf<RosettaSymbolDef>(def).metadata?.dynamicDescription).toBe("function"); // the discriminant
    expect(fired).toBe(0); // bake resolved NOTHING
  });

  it("symbol.native carries the same optional bag", () => {
    const def = symbol.native`law/meta-native: doc`({ input: [zz.number], output: [zz.number] }, (n) => n, {
      metadata: { docUrl: "https://example.test" },
    });
    expect(contractOf<NativeSymbolDef>(def).metadata?.docUrl).toBe("https://example.test");
  });

  it("staticMetadata — the §2.1 enumerable static subset, total at module load (zero assembly)", () => {
    const bag = { a: 1, b: "x", live: () => "nope" };
    expect(staticMetadata(bag)).toEqual({ a: 1, b: "x" });
    expect(staticMetadata(undefined)).toEqual({});
  });
});

describe("resolveMetadata — the unit surface (fake activation, no assembly)", () => {
  const activation = { configuration: { url: "https://cfg" }, resources: {}, degradation: {} } as unknown as Activation<
    any,
    any
  >;

  it("static fields pass through verbatim; dynamic fields resolve with `this` = the activation", async () => {
    const { resolved, dynamicKeys } = await resolveMetadata(
      {
        description: "static",
        endpoint: function (this: { configuration: { url: string } }) {
          return this.configuration.url;
        },
      },
      activation,
    );
    expect(resolved).toEqual({ description: "static", endpoint: "https://cfg" });
    expect(dynamicKeys).toEqual(["endpoint"]);
  });

  it("ruling 3: an undefined resolution omits the key and is NOT flagged dynamic", async () => {
    const { resolved, dynamicKeys } = await resolveMetadata(
      { description: "the static sibling", dynamicDescription: () => undefined },
      activation,
    );
    expect(resolved).toEqual({ description: "the static sibling" });
    expect("dynamicDescription" in resolved).toBe(false);
    expect(dynamicKeys).toEqual([]);
  });
});

describe("the ambient read path — describeSymbol/catalog resolve against the activation (§2.4)", () => {
  function fixture() {
    let fired = 0;
    let acquired = 0;
    const resource: Resource<{ dashboard: string }> = {
      kind: "law/meta-port",
      async acquire() {
        acquired += 1;
        return { dashboard: "42 users online", [Symbol.asyncDispose]: async () => {} };
      },
    };
    const capability = new EnvCapability("law/metadata", {
      // Configuration schemas are HOST-side plain zod (the config bag is JS data, not a
      // membrane crossing) — the same split every real capability uses.
      configuration: { greeting: hostZod.string().optional() },
      resources: { port: resource },
      symbols: {
        "law/verb": symbol.rosetta`law/verb: a verb with a live description`(
          { input: [], output: [zz.string] },
          () => "ran",
          {
            metadata: {
              description: "static description",
              // Reads CONFIG off the activation — the declared channel, not a closure.
              greetingLine: function (this: Activation<{ greeting: hostZod.ZodOptional<hostZod.ZodString> }, never>) {
                fired += 1;
                return this.configuration.greeting;
              },
              // Reads a RESOURCE off the activation — first read IS the first touch
              // (the cell's own lazy single-flight; ruling 1's second half).
              dashboard: async function (this: Activation<never, { port: Resource<{ dashboard: string }> }>) {
                const live = await this.resources.port.get();
                return live.dashboard;
              },
            },
          },
        ),
      },
    });
    return { capability, counts: { fired: () => fired, acquired: () => acquired } };
  }

  it("ruling 1: assembly resolves NOTHING; a read resolves; a resource-touching field spawns on first read", async () => {
    const { capability, counts } = fixture();
    const ambient = await assembleAmbient({ capabilities: [capability], config: { greeting: "hello, actor" } });
    try {
      expect(counts.fired()).toBe(0); // lower()+assembleEnv fired no metadata fn
      expect(counts.acquired()).toBe(0); // and spawned no resource for one either
      const described = await ambient.describeSymbol("law/verb");
      expect(described).toBeDefined();
      expect(described!.kind).toBe("rosetta");
      expect(described!.capability).toBe("law/metadata");
      expect(described!.doc).toBe("a verb with a live description");
      expect(described!.metadata.description).toBe("static description"); // static, verbatim
      expect(described!.metadata.greetingLine).toBe("hello, actor"); // dynamic, config channel
      expect(described!.metadata.dashboard).toBe("42 users online"); // dynamic, resource channel
      expect([...described!.dynamicKeys].toSorted()).toEqual(["dashboard", "greetingLine"]);
      expect(counts.acquired()).toBe(1); // the metadata read WAS the first touch
    } finally {
      await ambient.dispose();
    }
  });

  it("ruling 2: per-read, no memo — two describes fire the field twice", async () => {
    const { capability, counts } = fixture();
    const ambient = await assembleAmbient({ capabilities: [capability], config: { greeting: "hi" } });
    try {
      await ambient.describeSymbol("law/verb");
      await ambient.describeSymbol("law/verb");
      expect(counts.fired()).toBe(2);
    } finally {
      await ambient.dispose();
    }
  });

  it("catalog() — roster-ordered read over the same channel; unknown names describe as undefined", async () => {
    const { capability } = fixture();
    const ambient = await assembleAmbient({ capabilities: [capability], config: { greeting: "yo" } });
    try {
      const catalog = await ambient.catalog();
      expect(catalog.map((entry) => entry.name)).toEqual(["law/verb"]);
      expect(catalog[0].metadata.greetingLine).toBe("yo");
      expect(await ambient.describeSymbol("no-such-verb")).toBeUndefined();
    } finally {
      await ambient.dispose();
    }
  });

  it("ruling 3 on the ambient path: an absent optional key resolves undefined → static story only", async () => {
    const { capability } = fixture();
    const ambient = await assembleAmbient({ capabilities: [capability] }); // no greeting supplied
    try {
      const described = await ambient.describeSymbol("law/verb");
      expect("greetingLine" in described!.metadata).toBe(false); // omitted, honestly
      expect(described!.dynamicKeys).not.toContain("greetingLine"); // and NOT claimed dynamic
      expect(described!.metadata.description).toBe("static description"); // the static sibling stands
    } finally {
      await ambient.dispose();
    }
  });
});
