// scheme-env — bootstrap-sequence packs lower to kernel EnvPacks and run in C3 order.
import { describe, expect, it } from "vitest";

import { assembleEnv, type EnvPack } from "../kernel.js";
import { type EvalSchemeInto, schemePacks, type SchemeEnv } from "../scheme-env.js";

/** The recorder's OWN env type: the kernel is env-agnostic (`assembleEnv<E>`), so this
 *  suite instantiates E as a recorder carrying its own `set` face — deliberately NOT
 *  `SchemeEnv`, which (hermetic-Environment ruling) no longer has a write member. What
 *  these laws pin is pack ORDERING, and a pack's wire may do anything to ITS OWN E. */
type RecorderEnv = SchemeEnv & { set(name: string, value: unknown): unknown };

/** A fake env that records every contribution in order (bootstrap evals + wires). */
function recorder(): { env: RecorderEnv; log: string[] } {
  const log: string[] = [];
  const env: RecorderEnv = {
    set: (name) => (log.push(`set:${name}`), undefined),
    get: () => undefined,
    inherit: () => env,
    registerResolver: (resolver) => void log.push(`resolver:${resolver.id}`),
    list: () => [],
    allBoundNames: () => [],
  };
  return { env, log };
}

describe("schemePacks — bootstrap + wire, in dependency order", () => {
  // INVARIANT: a single pack evaluates its bootstrap THEN runs wire, in that order.
  it("evaluates bootstrap THEN runs wire for a single pack", async () => {
    const { env, log } = recorder();
    const evalScheme: EvalSchemeInto<RecorderEnv> = (_e, src) => void log.push(`eval:${src}`);
    const make = schemePacks(evalScheme);

    // The wire step exercises "wire can mutate env" generically — the exact env
    // method is incidental to what THIS law pins (bootstrap-then-wire ordering), so a
    // plain `set` stands in for the legacy `defineRosetta("op", { fn: () => 0 })` call
    // this fixture used before the migration (`defineRosetta` is retired from the
    // `SchemeEnv` contract entirely now — the mock above no longer declares it either).
    const pack = make({ name: "p", bootstrap: "(define-macro …)", wire: (e) => void e.set("op", 0) });
    await assembleEnv(env, [pack]);

    expect(log).toEqual(["eval:(define-macro …)", "set:op"]);
  });

  // INVARIANT: a dependency's bootstrap runs before its dependent's (C3 order).
  it("a dependency's bootstrap runs before its dependent's (C3 order)", async () => {
    const { env, log } = recorder();
    const make = schemePacks<RecorderEnv>((_e, src) => void log.push(src));

    const base = make({ name: "base", bootstrap: "BASE" });
    const dependent = make({ name: "dependent", deps: [base], bootstrap: "DEPENDENT" });
    await assembleEnv(env, [dependent]);

    // least-precedence (deps) applied first ⇒ BASE before DEPENDENT.
    expect(log).toEqual(["BASE", "DEPENDENT"]);
  });

  // INVARIANT: schemePacks produces a plain kernel EnvPack that composes with pure-JS packs.
  it("produces a plain kernel EnvPack (composes with pure-JS packs)", async () => {
    const { env, log } = recorder();
    const make = schemePacks<RecorderEnv>((_e, src) => void log.push(`scm:${src}`));

    const schemePack = make({ name: "scheme", bootstrap: "DEFS" });
    const jsPack: EnvPack<RecorderEnv> = { name: "js", apply: (e) => void e.set("native", 1) };
    await assembleEnv(env, [jsPack, schemePack]);

    expect(log.sort()).toEqual(["scm:DEFS", "set:native"]);
  });

  // INVARIANT: a bootstrap-less pack runs only its wire step, never evaluating anything.
  it("a bootstrap-less pack is just its wire (no eval)", async () => {
    const { env, log } = recorder();
    const make = schemePacks<RecorderEnv>(() => void log.push("EVAL-SHOULD-NOT-RUN"));
    await assembleEnv(env, [make({ name: "wire-only", wire: (e) => void e.set("x", 1) })]);
    expect(log).toEqual(["set:x"]);
  });
});
