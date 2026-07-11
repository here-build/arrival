/**
 * resolution-chain.law.test.ts — laws for the SEALED ambient artifact (ENV T2,
 * docs/working-proposals/environment-resolution-chain.md §§1–2).
 *
 * LAW 1 (precedence preservation): `compile(env).lookup ≡ env._lookupWithResolvers`
 *   over any layer/resolver topology — the module-composition ordering pins re-homed
 *   onto the compiled form (same rows, chain side; the live-walk pins themselves are
 *   UNCHANGED in module-composition.spec.ts).
 * LAW 2 (merge-at-seal): resolver-free spans merge child-wins into ONE flat map; a
 *   resolver splits the merge exactly at its layer position. The bootstrapped in-repo
 *   base is the DEGENERATE form (zero live resolvers ⇒ steps = [oneFlatMap]).
 * LAW 3 (memo soundness): a pure resolver's hit promotes ONCE with stable identity,
 *   consulted before ITS STEP only (an earlier impure resolver keeps winning); misses
 *   cache iff ALL resolvers are pure.
 * LAW 4 (content address): deterministic per topology; sensitive to vocabulary and to
 *   resolver identity/purity. Value hashing is deferred (design open question 1).
 * LAW 5 (bake-seal residue): assembly leaves NO resolver registered on the base — the
 *   `preludeOnly` overlay is bake-scoped and dropped at seal (T1's spent-resolver
 *   dead weight is structurally gone).
 */
import { describe, expect, it } from "vitest";

import { Environment, ResolvingEnvironment } from "../../Environment.js";
import {
  CompiledResolver,
  compileResolutionChain,
  sealResolutionChain,
} from "../../eval/CompiledResolutionChain.js";
import { assembleEnv, type EnvPack } from "../../common/kernel.js";
import { exec } from "../../eval/generator-exec.js";
import { user_env, global_env } from "../../env-roots.js";
import { AExact } from "../../values/primitives/AExact.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
// In-package test: the module-internal storage write (hermetic-Environment ruling — no public set).
import { bindValue } from "../../Environment.js";

const boxed = (n: bigint) => new AExact(CONSTANT_CTX, n);

describe("CompiledResolutionChain — LAW 1: precedence preservation", () => {
  it("re-homes the module-composition rows: own bindings → own resolvers → parent, per layer", () => {
    // The exact topology module-composition.spec.ts pins on the LIVE walk.
    const parent = new ResolvingEnvironment("parent", { x: boxed(1n) }, null);
    parent.registerResolver({ id: "parent-resolver", resolve: (name) => (name === "y" ? boxed(2n) : undefined) });
    const child = new ResolvingEnvironment("child", { z: boxed(3n) }, parent);
    child.registerResolver({ id: "child-resolver", resolve: (name) => (name === "w" ? boxed(4n) : undefined) });

    const chain = compileResolutionChain(child);

    // Row-for-row equivalence with the live walk:
    expect(chain.lookup("z")).toEqual(boxed(3n)); // direct binding in child
    expect(chain.lookup("w")).toEqual(boxed(4n)); // resolver in child
    expect(chain.lookup("x")).toEqual(boxed(1n)); // binding in parent (child resolver yields)
    expect(chain.lookup("y")).toEqual(boxed(2n)); // resolver in parent (child resolver yields)
    expect(chain.lookup("not-found")).toBeUndefined();

    // …and the step form is the flattened layer sequence, split at each resolver's position:
    // [map(child), r(child), map(parent), r(parent)] (design §2).
    expect(chain.steps).toHaveLength(4);
    expect(chain.steps[0]).toBeInstanceOf(Map);
    expect(chain.steps[1]).toBeInstanceOf(CompiledResolver);
    expect(chain.steps[2]).toBeInstanceOf(Map);
    expect(chain.steps[3]).toBeInstanceOf(CompiledResolver);
  });

  it("a layer's own binding beats its own resolver (a pinned override survives a catch-all)", () => {
    const env = new ResolvingEnvironment("layer", { pinned: boxed(10n) }, null);
    env.registerResolver({ id: "catch-all", resolve: () => boxed(99n) });
    const chain = compileResolutionChain(env);
    expect(chain.lookup("pinned")).toEqual(boxed(10n));
    expect(env._lookupWithResolvers("pinned")).toEqual(chain.lookup("pinned"));
  });

  it("resolvers fire in registration order within a layer", () => {
    const order: string[] = [];
    const env = new ResolvingEnvironment("layer", {}, null);
    env.registerResolver({
      id: "first",
      resolve: (name) => {
        order.push("first");
        return undefined; // yield
      },
    });
    env.registerResolver({
      id: "second",
      resolve: (name) => {
        order.push("second");
        return name === "target" ? boxed(42n) : undefined;
      },
    });
    const chain = compileResolutionChain(env);
    expect(chain.lookup("target")).toEqual(boxed(42n));
    expect(order).toEqual(["first", "second"]);
  });
});

describe("CompiledResolutionChain — LAW 2: merge-at-seal", () => {
  it("resolver-free layers merge child-wins into ONE flat map", () => {
    const root = new Environment("root", { a: boxed(1n), shadowed: boxed(100n) }, null);
    const mid = new Environment("mid", { b: boxed(2n), shadowed: boxed(200n) }, root);
    const leaf = new Environment("leaf", { c: boxed(3n), shadowed: boxed(300n) }, mid);

    const chain = compileResolutionChain(leaf);
    expect(chain.steps).toHaveLength(1);
    expect(chain.steps[0]).toBeInstanceOf(Map);
    expect(chain.lookup("a")).toEqual(boxed(1n));
    expect(chain.lookup("b")).toEqual(boxed(2n));
    expect(chain.lookup("c")).toEqual(boxed(3n));
    expect(chain.lookup("shadowed")).toEqual(boxed(300n)); // child wins
    expect(chain.names.has("a")).toBe(true);
    expect(chain.names.has("shadowed")).toBe(true);
    expect(chain.names.has("nope")).toBe(false);
  });

  it("THE IN-REPO REALITY: the bootstrapped base compiles to the degenerate ONE-flat-Map form", async () => {
    await exec("1"); // force the realm bootstrap (bake + seal)

    // Zero live resolvers: no pack declares `spec.resolvers`, and the kernel's
    // preludeOnly overlay was dropped at seal (LAW 5) — verify on the real roots.
    expect(user_env.resolverSpecs()).toHaveLength(0);
    expect(global_env.resolverSpecs()).toHaveLength(0);

    const chain = sealResolutionChain(user_env);
    expect(chain.steps).toHaveLength(1);
    expect(chain.steps[0]).toBeInstanceOf(Map);
    // The merged vocabulary spans BOTH roots: a native on global_env, a .scm define on user_env.
    expect(chain.lookup("+")).toBeDefined();
    expect(chain.lookup("cons")).toBeDefined();
    expect(chain.lookup("definitely-not-bound-xyz")).toBeUndefined();

    // ONE artifact per baked base — the seal registry memoizes.
    expect(sealResolutionChain(user_env)).toBe(chain);
  });
});

describe("CompiledResolutionChain — LAW 3: memo + negative-cache soundness", () => {
  it("a PURE resolver's hit promotes once, with stable identity", () => {
    let calls = 0;
    // A first-class boxed sentinel: resolvers answer with BOXED values only (the
    // hermetic ruling's resolver contract) — identity is what this law pins.
    const value = boxed(7n);
    const env = new ResolvingEnvironment("layer", {}, null);
    env.registerResolver({
      id: "pure-synth",
      pure: true,
      resolve: (name) => {
        if (name !== "synth") return undefined;
        calls++;
        return value;
      },
    });
    const chain = compileResolutionChain(env);
    const first = chain.lookup("synth");
    const second = chain.lookup("synth");
    expect(calls).toBe(1); // promoted after the first probe
    expect(second).toBe(first); // (eq? x x) — identity preserved across lookups
  });

  it("an IMPURE resolver is probed every time (nothing cached through it)", () => {
    let calls = 0;
    const env = new ResolvingEnvironment("layer", {}, null);
    env.registerResolver({
      id: "dynamic",
      resolve: (name) => {
        calls++;
        return name === "dyn" ? boxed(BigInt(calls)) : undefined;
      },
    });
    const chain = compileResolutionChain(env);
    expect(chain.lookup("dyn")).toEqual(boxed(1n));
    expect(chain.lookup("dyn")).toEqual(boxed(2n)); // live answer, never memoized
  });

  it("negative caching holds iff ALL resolvers are pure", () => {
    // ALL-pure: a chain-wide miss is memoized — the resolver is probed once.
    let pureCalls = 0;
    const allPure = new ResolvingEnvironment("all-pure", {}, null);
    allPure.registerResolver({
      id: "pure",
      pure: true,
      resolve: () => {
        pureCalls++;
        return undefined;
      },
    });
    const pureChain = compileResolutionChain(allPure);
    expect(pureChain.lookup("missing")).toBeUndefined();
    expect(pureChain.lookup("missing")).toBeUndefined();
    expect(pureCalls).toBe(1);

    // ONE impure resolver disables miss-caching globally.
    let impureCalls = 0;
    const mixed = new ResolvingEnvironment("mixed", {}, null);
    mixed.registerResolver({ id: "pure", pure: true, resolve: () => undefined });
    mixed.registerResolver({
      id: "impure",
      resolve: () => {
        impureCalls++;
        return undefined;
      },
    });
    const mixedChain = compileResolutionChain(mixed);
    expect(mixedChain.lookup("missing")).toBeUndefined();
    expect(mixedChain.lookup("missing")).toBeUndefined();
    expect(impureCalls).toBe(2); // the dynamic middleware may start answering tomorrow
  });

  it("a pure step's memo never shortcuts an EARLIER impure step", () => {
    // Topology: impure resolver REGISTERED BEFORE a pure one in the same layer. Once the
    // pure step promotes a name, the impure step must still be probed first on every
    // lookup — it may start answering tomorrow, and its position wins.
    const fromPure = boxed(1n);
    const fromImpure = boxed(2n);
    let impureAnswer: AExact | undefined;
    const env = new ResolvingEnvironment("layer", {}, null);
    env.registerResolver({ id: "impure-first", resolve: () => impureAnswer });
    env.registerResolver({ id: "pure-second", pure: true, resolve: (n) => (n === "name" ? fromPure : undefined) });
    const chain = compileResolutionChain(env);

    expect(chain.lookup("name")).toBe(fromPure); // promoted into the pure step's memo
    impureAnswer = fromImpure; // the dynamic middleware starts answering
    expect(chain.lookup("name")).toBe(fromImpure); // position still wins over the memo
  });
});

describe("CompiledResolutionChain — LAW 4: content address", () => {
  it("deterministic per topology, sensitive to vocabulary and resolver identity", () => {
    const build = () => {
      const root = new ResolvingEnvironment("root", { a: boxed(1n) }, null);
      root.registerResolver({ id: "r1", resolve: () => undefined });
      return new Environment("leaf", { b: boxed(2n) }, root);
    };
    const h1 = compileResolutionChain(build()).hash;
    const h2 = compileResolutionChain(build()).hash;
    expect(h2).toBe(h1); // deterministic composition (realm-independent)

    const widened = build();
    bindValue(widened, "c", boxed(3n));
    expect(compileResolutionChain(widened).hash).not.toBe(h1); // vocabulary-sensitive

    const repure = new ResolvingEnvironment("root", { a: boxed(1n) }, null);
    repure.registerResolver({ id: "r1", pure: true, resolve: () => undefined });
    const leaf = new Environment("leaf", { b: boxed(2n) }, repure);
    expect(compileResolutionChain(leaf).hash).not.toBe(h1); // purity-sensitive
  });
});

describe("CompiledResolutionChain — LAW 5: the bake seal leaves zero resolver residue", () => {
  it("the preludeOnly overlay is registered during the bake and DROPPED at seal", async () => {
    const base = new ResolvingEnvironment("bake-seal-law", {}, null);
    let duringBake: { resolvers: number; visible: unknown } | undefined;
    const pack: EnvPack<ResolvingEnvironment> = {
      name: "law/bake-overlay",
      apply(env, ctx) {
        expect(ctx.preludeScope).toBeDefined(); // bootstrap assembly ALWAYS provides it
        ctx.preludeScope!.set("bake-only", boxed(42n)); // boxed: the overlay resolver serves this through the resolution walk, and resolution carries boxed values only (hermetic ruling)
        duringBake = {
          resolvers: env.resolverSpecs().length,
          visible: env._lookupWithResolvers("bake-only"),
        };
      },
    };
    await assembleEnv(base, [pack]);

    // During the bake: overlay registered, binding visible through the live walk.
    expect(duringBake).toEqual({ resolvers: 1, visible: boxed(42n) });
    // At seal: unregistered — NO resolver remains on the env (zero residue), and the
    // name is a plain miss everywhere.
    expect(base.resolverSpecs()).toHaveLength(0);
    expect(base._lookupWithResolvers("bake-only")).toBeUndefined();
    // The compiled form of this base is therefore the degenerate flat map.
    expect(compileResolutionChain(base).steps).toHaveLength(1);
  });
});
