/**
 * LAW (V0) — docs/working-proposals/arrival-environment-privatization.md, wave V0:
 * "pins (no behavior)". Three pins the V1/V2 mechanical cuts lean on:
 *
 *   1. Barrel surface pin — `global_env`/`env` are GONE (V1's zero-consumer cut);
 *      `sandboxedEnv` stays (deprecated in V1's JSDoc, hard-delete is D5's LATER wave);
 *      `LexicalScope.fresh` exists (V1's one new API).
 *   2. Glass byte-identity — a custom `{ env }` run still resolves/defines exactly as
 *      before the `ExecOptions.env: SchemeEnv` retype (D2): the retype is a TYPE-level
 *      change only (frees external glass callers from the private
 *      `ReturnType<typeof sandboxedEnv.inherit>` alias onto the public `SchemeEnv`
 *      contract) — the runtime walk (`new Resolver(actualEnv)`, defines land directly
 *      in the glass env) is untouched.
 *   3. override+scope value-injection parity — the census's own migration-target claim
 *      (§II.1's table: `env.set(name, jsToScheme(ctx, dataValue))` → `override`) is
 *      pinned as an actual equality: both paths must produce identical values AND
 *      identical provenance (both fold through `jsToScheme(CONSTANT_CTX, …)` —
 *      `overridable/resolve`'s own implementation, env/overridable.ts — so a
 *      divergence here would mean the two "run-neutral value" doors disagree).
 */
import { describe, expect, it } from "vitest";
import * as arrival from "../../index.js";
import { exec, execState } from "../../eval/generator-exec.js";
import { LexicalScope } from "../../eval/LexicalScope.js";
import { inferenceEnv as sandboxedEnv } from "../../inference-env.js";
import { jsToScheme } from "../../rosetta.js";
import { CONSTANT_CTX } from "../../values/primitives/RunContext.js";
import { AValue } from "../../values/primitives/AValue.js";

describe("V0 pin — barrel surface", () => {
  it("global_env / env are no longer barrel-exported (V1 zero-consumer cut)", () => {
    const names = Object.keys(arrival);
    expect(names).not.toContain("global_env");
    expect(names).not.toContain("env");
  });

  it("sandboxedEnv stays barrel-exported (D5: hard-delete is a LATER, one-atomic-wave cut — not this round)", () => {
    expect(arrival.sandboxedEnv).toBeDefined();
    expect(typeof arrival.sandboxedEnv.inherit).toBe("function");
  });

  it("LexicalScope.fresh exists (V1's one new public API, D6)", () => {
    expect(typeof arrival.LexicalScope.fresh).toBe("function");
  });

  it("the full exported-name set is otherwise unchanged by this round (pin — update deliberately, on purpose, never by accident)", () => {
    const names = Object.keys(arrival).sort();
    expect(names).toMatchSnapshot();
  });
});

describe("V0 pin — glass byte-identity (ExecOptions.env retype is type-only, D2)", () => {
  it("a custom env still resolves builtins through its OWN chain and defines land directly in it — the glass posture generator-exec.ts documents", async () => {
    const base = sandboxedEnv.inherit("glass-pin-basic");
    const [sum] = await exec("(+ 1 2)", { env: base });
    expect(sum).toBe(3);

    await exec("(define answer 41)", { env: base });
    const [next] = await exec("(+ answer 1)", { env: base });
    expect(next).toBe(42);

    // The define landed ON the glass env itself — no hidden cut/session-frame
    // indirection (byte-identical to pre-cut glass, generator-exec.ts's own
    // "GLASS — the resolver wraps it directly" comment).
    expect(base.get("answer", { throwError: false })).toBeDefined();
  });

  it("execState's glass posture is unaffected — session `scope` wraps the SAME glass env across calls", async () => {
    const base = sandboxedEnv.inherit("glass-pin-session");
    await execState("(define greeting \"hi\")", { env: base });
    const { values } = await execState("(string-append greeting \" there\")", { env: base });
    expect(values[0]).toBeInstanceOf(AValue);
  });
});

describe("V0 pin — override+scope value-injection parity", () => {
  it("env.set + jsToScheme and define/overridable + override produce IDENTICAL values", async () => {
    const users = [
      { id: "alice", priority: 15 },
      { id: "bob", priority: 5 },
    ];

    // The manual membrane path (README's "Passing data across", the pre-override idiom).
    const manualEnv = sandboxedEnv.inherit("parity-manual");
    manualEnv.set("users", jsToScheme(CONSTANT_CTX, users, {}));
    const { values: manualValues } = await execState(
      `(map (lambda (u) (:id u)) users)`,
      { env: manualEnv },
    );

    // The declared-parameter path (`override`, the census's migration target).
    const { values: declaredValues } = await execState(
      `(define/overridable users (s/array (s/object (s/field/string "id") (s/field/number "priority"))) '())
       (map (lambda (u) (:id u)) users)`,
      { override: { users } },
    );
    const declaredResult = declaredValues.at(-1);
    const manualResult = manualValues.at(-1);
    expect(declaredResult).toBeDefined();
    expect(manualResult).toBeDefined();

    // Same shape, same order — the map result over the same source list.
    expect(JSON.stringify(declaredResult)).toBe(JSON.stringify(manualResult));
  });

  it("...and IDENTICAL provenance — both paths mint through jsToScheme(CONSTANT_CTX, …), so both are provenance-empty (run-neutral)", async () => {
    const priority = 15;

    const manualEnv = sandboxedEnv.inherit("parity-provenance-manual");
    manualEnv.set("priority", jsToScheme(CONSTANT_CTX, priority, {}));
    const { values: manualValues } = await execState(`(* priority 2)`, { env: manualEnv });

    const { values: declaredValues } = await execState(
      `(define/overridable priority (s/number) 0)
       (* priority 2)`,
      { override: { priority } },
    );

    const manualResult = manualValues.at(-1);
    const declaredResult = declaredValues.at(-1);
    expect(manualResult).toBeInstanceOf(AValue);
    expect(declaredResult).toBeInstanceOf(AValue);
    expect([...(declaredResult as AValue).provenance].sort()).toEqual(
      [...(manualResult as AValue).provenance].sort(),
    );
    // Both empty — neither path mints a fresh point (CONSTANT_CTX, both sides).
    expect((manualResult as AValue).provenance.size).toBe(0);
  });
});
