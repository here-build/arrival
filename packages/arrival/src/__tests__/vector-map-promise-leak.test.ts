// Caveat-sweep finding (2026-06-11), section B #2: vector-map / vector-for-each /
// string-map / string-for-each push `proc(...)` straight into the result without
// the is_promise/promise_all handling that the list `map` (stdlib.ts) has. When
// `proc` is an async membrane callback (returns a JS Promise — the common case in
// arrival, where procs hit async rosetta/FFI boundaries), the result holds
// unresolved Promises that stringify to "[object Promise]" and carry NO
// provenance (defeating boxing goal-b). The fix mirrors list map: collect, and if
// any result is a promise, return promise_all(...).then(...) so the trampoline
// awaits settled values.
import { describe, expect, it } from "vitest";
import { freshEnv } from "./_fresh-env.js";
import { execStateOverFrame as execState } from "../eval/generator-exec.js";
import { ANativeProcedure } from "../values/primitives/ANativeProcedure.js";
import { AExact } from "../values/primitives/AExact.js";
import { theVoid } from "../values/primitives/AVoid.js";
import type { SchemeValue } from "../values/types.js";
// In-package test: the module-internal storage write (hermetic-Environment ruling — no public set).
import { bindValue } from "../env/AmbientRuntime.js";

const env = await freshEnv();
// COMPLEX tier (execState): stringifies the BOXED result (Scheme print format,
// e.g. list "(2 4 6)") — a boxed-state read, not the SIMPLE tier's plain-JS exit.
const run = async (form: string) => String((await execState(form, { env })).values[0]);

// An async ANativeProcedure returning a Promise — mirrors a membrane-crossing callback.
// W8: bare host fns are doored at bindValue.
bindValue(
  env,
  "async-double",
  new ANativeProcedure({
    name: "async-double",
    arity: { min: 1, max: 1 },
    contract: undefined,
    impl: async (args) => new AExact(Number((args[0] as { valueOf(): number }).valueOf()) * 2) }),
);
bindValue(
  env,
  "async-noop",
  new ANativeProcedure({
    name: "async-noop",
    arity: { min: 0, max: null },
    contract: undefined,
    impl: async () => theVoid }),
);

describe("vector/string map+for-each await async procs (no raw Promise leak)", () => {
  it("vector-map with an async proc yields settled values, not [object Promise]", async () => {
    // Assert via vector->list so the harness reprs the SETTLED elements (a raw
    // JS String() on the SchemeVector would print "[object Object]" regardless).
    const out = await run(`(vector->list (vector-map async-double (vector 1 2 3)))`);
    expect(out).not.toMatch(/\[object Promise\]/);
    expect(out).toBe("(2 4 6)");
  });

  it("string-map with an async proc yields settled chars, not [object Promise]", async () => {
    // identity-ish async proc over chars
    bindValue(
      env,
      "async-char",
      new ANativeProcedure({
        name: "async-char",
        arity: { min: 1, max: 1 },
        contract: undefined,
        impl: async (args) => args[0] as SchemeValue }),
    );
    const out = await run(`(string-map async-char "abc")`);
    expect(out).not.toMatch(/\[object Promise\]/);
  });

  it("vector-for-each with an async proc completes (awaits) before returning", async () => {
    // for-each returns void; the point is it must AWAIT the async proc rather than
    // returning while promises are still outstanding.
    await expect(run(`(vector-for-each async-noop (vector 1 2 3))`)).resolves.toBeDefined();
  });
});
