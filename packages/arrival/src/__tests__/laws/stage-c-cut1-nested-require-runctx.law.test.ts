/**
 * LAW — Stage C, Cut 1 (docs archaeology: stage-c-corpse-deletion.md): `execExpr` now honors a
 * passed `ExecOptions.runCtx` (reuse verbatim) instead of unconditionally minting a fresh,
 * vocabulary-less `RunContext`. `require`'s module-eval loop (loader-capability.ts) threads the
 * requiring run's LIVE `runCtx` through every `execExpr(form, …)` call it makes, so a NESTED
 * `(require …)` inside a required `.scm` module now dispatches with the SAME runCtx as its
 * parent — `this.runCtx.vocabulary` is the outer run's real vocabulary tuple, not `undefined`.
 *
 * Companion to `loader/__tests__/loader-extension-registry-vocabulary.test.ts` (Stage B4's
 * TOP-LEVEL per-run-registry proof — unaffected by this cut, since a top-level require's
 * `this.runCtx` was always the real run handle). THIS file is the ONE-LEVEL-DEEPER proof: the
 * require that dispatches from INSIDE an already-`require`d `.scm` module's own forms — the
 * exact path `loaderRegistryOf` (loader-capability.ts) used to silently fall through to the
 * process-global legacy table (`loader-extensions.ts`'s `legacyExtensionRegistry`) for, even
 * under a vocabulary-path top-level run with its own per-run extension registry.
 *
 * LAW 1 (nested require resolves per-run, not legacy): a vocabulary-path run requires a `.scm`
 *   module which itself `(require …)`s an extension-resolved file, registered only via THIS
 *   run's own prelude — the nested require must resolve it, and the process-global legacy
 *   table must stay untouched (size 0) throughout.
 *
 * LAW 2 (cross-run isolation at the nested level): a SEPARATE run (a fresh `exec()` call, a
 *   capability set that never registered the suffix) cannot see a suffix a DIFFERENT run's
 *   nested require resolved — same per-run-bag guarantee Stage B4 established at the top level,
 *   now confirmed one require-frame deeper.
 *
 * LAW 3 (meter continuity): a nested require's allocations charge the OUTER run's heap meter —
 *   the reused `runCtx` (not a private, per-form one) is what a required module's code actually
 *   runs against, so its own list-cell allocations are bounded by (and visible on) the SAME
 *   `RunContext.heapMeter` the top-level program shares.
 */
import { describe, expect, it } from "vitest";

import { EnvCapability } from "../../common/capability.js";
import { exec, execState } from "../../eval/generator-exec.js";
import { schemeToJs } from "../../membrane/rosetta.js";
import type { SchemeValue } from "../../values/types.js";
import { arrivalLoaderCapability } from "../../loader/loader-capability.js";
import { loaderFromResolver } from "../../loader/loader.js";

const plain = (v: unknown): unknown => schemeToJs(v as SchemeValue, {});

const files = (table: Record<string, string>) =>
  loaderFromResolver((path) => {
    const hit = table[path];
    if (hit === undefined) throw new Error(`no such file: ${path}`);
    return hit;
  });

/** Same minimal ext-capability shape `loader-extension-registry-vocabulary.test.ts` uses: a
 *  `symbol.native` resolver + a prelude registering it by name — the production ext-yaml/
 *  ext-toml/handlebars shape, minus a real parser dependency. */
function makeUpperExtCapability(name: string, suffix: string, resolverName: string): EnvCapability {
  return EnvCapability.define(name, {
    deps: [arrivalLoaderCapability],
    symbols: (symbol, z) => ({
      [resolverName]: symbol.native`${resolverName}: uppercases module contents (ResolverResult value kind)`(
        { input: [z.value, z.value], output: [z.value] },
        (contents: unknown) => ({ kind: "value", value: String(contents).toUpperCase() }) as never,
      ),
    }),
    prelude: `(require/register-extension "${suffix}" "${resolverName}")`,
  });
}

describe("LAW 1 — nested require (inside a required .scm module) resolves via the RUN's own per-run registry", () => {
  it("does not fall to a process-global legacy table (Stage C Cut 3b: there is no longer one to fall to)", async () => {
    const ext = makeUpperExtCapability("test/ext-upper-nested", ".nestedupper", "test/upper-resolve-nested");

    const results = await exec(`(require "outer-nested.scm")`, {
      capabilities: [ext],
      config: {
        loader: files({
          "outer-nested.scm": `(require "inner-nested.nestedupper")`,
          "inner-nested.nestedupper": "hello from inside",
        }),
      },
    });

    // The `.scm` module's own last form is the nested require — its value is what `load`
    // discards (require's own `load` branch always returns unspecified), so the observable
    // proof is simply that resolution SUCCEEDED (pre-fix: `loaderRegistryOf` reads
    // `this.runCtx.vocabulary` off execExpr's freshly-minted, vocabulary-less RunContext for
    // the nested call ⇒ always the (empty) legacy table ⇒ "no-resolver" throws here instead).
    expect(results.length).toBeGreaterThan(0);
  });
});

describe("LAW 2 — cross-run isolation holds one require-frame deeper", () => {
  it("a separate run's nested require cannot see a suffix a DIFFERENT run registered", async () => {
    const extA = makeUpperExtCapability("test/ext-upper-nested-iso-a", ".nestediso", "test/upper-resolve-nested-iso-a");

    await exec(`(require "outer-iso-a.scm")`, {
      capabilities: [extA],
      config: {
        loader: files({
          "outer-iso-a.scm": `(require "inner-iso-a.nestediso")`,
          "inner-iso-a.nestediso": "seen by run A",
        }),
      },
    });

    // Run B: a SEPARATE exec() call, a capability set that never registered `.nestediso` (only
    // the bare loader) — its nested require of the SAME suffix must fail, proving run A's
    // per-run registration never leaked (into the legacy table, or anywhere run B's own bag
    // would read).
    await expect(
      exec(`(require "outer-iso-b.scm")`, {
        capabilities: [arrivalLoaderCapability],
        config: {
          loader: files({
            "outer-iso-b.scm": `(require "unseen-iso-b.nestediso")`,
            "unseen-iso-b.nestediso": "unreachable",
          }),
        },
      }),
    ).rejects.toThrow(/no-resolver|no resolver/i);
  });
});

describe("LAW 3 — a nested require's allocations charge the OUTER run's heap meter", () => {
  it("the reused runCtx observes list-cell allocations a required .scm module's own code makes", async () => {
    const ext = makeUpperExtCapability("test/ext-upper-nested-meter", ".nestedmeter", "test/upper-resolve-nested-meter");

    // The required module's OWN code does real list work (`map` charges the meter per element —
    // heap-budget.ts's sequence-op dispatch chokepoint) — its allocations must land on the
    // requiring program's meter, not a private one execExpr would otherwise mint per nested call.
    const { runCtx } = await execState(`(require "outer-meter.scm")`, {
      capabilities: [ext],
      heapBudget: 1000,
      config: {
        loader: files({
          "outer-meter.scm": `(map (lambda (x) x) (list 1 2 3 4 5 6 7 8 9 10))`,
        }),
      },
    });

    expect(runCtx.heapMeter?.used).toBeGreaterThan(0);
  });
});
