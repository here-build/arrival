// overridable-symbol-define.test.ts — W4-H2b pack migration rows for `arrival/overridable`
// (docs/design-history/symbol-define-static-program-validation.md §1/§2/§4). Companion to
// the pre-existing `overridable.test.ts`, which stays the behavioral baseline (define, override,
// default, structured s/* forms, teaching-door messages) — this file pins ONLY the migration-
// specific facts:
//
//   ROW 1 — structural: no `prelude` field survives; `define/overridable` is now a
//     `kind: "define-syntax"` entry, contract-free, `macroAttribute: "binder"`; the sibling
//     `overridable/resolve` rosetta entry is BYTE-UNTOUCHED (still `kind: "rosetta"`, still
//     carries its `in`/`out` contract) — the rosetta arm was never prelude text to begin with.
//   ROW 2 — the §2.1 bake FV law is categorically out of scope for this pack's ONE
//     `defineSyntax` entry (`define-bake.ts` limits that check to `def.kind === "define"`,
//     same fact srfi-8/26 and H1's binder/opaque siblings pin) — lowering standalone, with the
//     existing `deps: [schemaCapability]` unchanged, never throws a bake/role door. Regression
//     pin, not a new capability.
//   ROW 3 — end-to-end through the ONE consumer door (`exec(src, { capabilities, config })`):
//     define/override/resolve still behaves identically post-migration — the baseline's own
//     coverage, re-run here as the migration's own gate rather than duplicated in full.
//   ROW 4 — a teaching-door message survives the migration byte-for-byte (the macro's expansion
//     into `overridable/resolve` is unchanged, so the "expected X, got Y (from …)" shape must be
//     unchanged too).
//   ROW 5 — the §3.4 macro firewall: `name`'s FORMALS position (the reasoning pinned in
//     overridable.ts's own migration-note comment — `name` binds, it is never read back as a
//     value reference in the expansion, unlike `type`/`default` which ARE ordinary expression
//     space) never false-positives as `unbound-symbol` under `staticValidation: "on"` — the
//     exact false positive the doc's `receive`/`and-let*` worked cases motivate the ternary
//     over. A genuinely unbound name used as the `default` expression still reports (the
//     firewall covers the formal, not the whole call — today's honest, whole-call-firewalled
//     interim per §3.4's DEFERRED per-position walker note).
import { describe, expect, it } from "vitest";
import { mintFrame } from "../../AmbientRuntime.js";

import { exec, execState, initBridge, LexicalScope, type ExecOptions } from "../../../index.js";
import { AString } from "../../../values/primitives/AString.js";
import { global_env } from "../../env-roots.js";
import { DefineForwardReferenceError, DefineLocalityError, ProvenanceRoleShapeError } from "../../../errors.js";
import { overridableCapability } from "../../overridable/overridable.js";
import type { AEntity, DefineSyntaxSymbolDef } from "../../../common/symbol.js";
import { contractOf, type SymbolDeclaration } from "../../../common/capability.js";
import type { ResolvingAmbient } from "../../AmbientRuntime.js";

const capabilities = [overridableCapability];

// Local evalScheme, mirroring `_fresh-env.ts`'s own — used only by the standalone
// lower()/apply() rows below (the FV-law regression pin), never by the exec() rows.
const evalScheme = (env: unknown, src: unknown): unknown =>
  exec(src as string, { env: env as ResolvingAmbient, skipBootstrapWait: true });

// `spec.symbols` IS the record (the builder-form arm is retired; a define-form spec carries
// the eagerly-evaluated literal), so reading it needs no activation.
function resolveSymbols(): Record<string, SymbolDeclaration> {
  return overridableCapability.spec.symbols ?? {};
}

describe("arrival/overridable — structural: no prelude field, define-syntax kind, rosetta untouched", () => {
  it("`define/overridable` is a `define-syntax` entry — contract-free, macroAttribute binder", () => {
    const def = resolveSymbols()["define/overridable"] as DefineSyntaxSymbolDef;
    expect(def).toBeDefined();
    expect(def.kind).toBe("define-syntax");
    expect(def).not.toHaveProperty("in");
    expect(def).not.toHaveProperty("out");
    expect(def.macroAttribute).toBe("binder");
  });

  it("`overridable/resolve` stays a `rosetta` entry with its `in`/`out` contract intact (never migrated)", () => {
    // Stage A2: `overridable/resolve` mints an ARosettaProcedure directly now — its
    // CONTRACT (still `kind: "rosetta"`, still carrying `in`/`out`) rides `.contract`.
    const def = contractOf(resolveSymbols()["overridable/resolve"]) as (AEntity & { in?: unknown; out?: unknown }) | undefined;
    expect(def).toBeDefined();
    expect(def!.kind).toBe("rosetta");
    expect(def!.in).toBeDefined();
    expect(def!.out).toBeDefined();
  });

  it("the capability declares no `prelude` field", () => {
    expect(overridableCapability.spec.prelude).toBeUndefined();
  });
});

describe("arrival/overridable — the §2.1 bake FV law is out of scope for defineSyntax (regression pin)", () => {
  it("lowers standalone (existing deps unchanged), never throws a bake FV/role door", async () => {
    await initBridge();
    const env = mintFrame(global_env, "overridable-standalone");
    await expect(
      overridableCapability.lower({ evalScheme, config: { params: {} } }).apply(env, undefined as never),
    ).resolves.not.toThrow();
  });

  it("never throws DefineLocalityError/DefineForwardReferenceError/ProvenanceRoleShapeError", async () => {
    await initBridge();
    const env = mintFrame(global_env, "overridable-fv-pin");
    try {
      await overridableCapability.lower({ evalScheme, config: { params: {} } }).apply(env, undefined as never);
    } catch (error) {
      expect(error).not.toBeInstanceOf(DefineLocalityError);
      expect(error).not.toBeInstanceOf(DefineForwardReferenceError);
      expect(error).not.toBeInstanceOf(ProvenanceRoleShapeError);
      throw error; // any OTHER failure is a real regression — surface it
    }
  });
});

describe("arrival/overridable — end-to-end through the ONE consumer door, post-migration", () => {
  it("a host-supplied override still wins over the in-form default, and validates", async () => {
    const result = (
      await exec(`(define/overridable city (s/string) "Berlin") city`, {
        capabilities,
        config: { params: { city: "Paris" } },
      })
    ).at(-1);
    expect(result).toBe("Paris");
  });

  it("default fallback still fires (and validates) when no override is supplied", async () => {
    const result = (
      await exec(`(define/overridable city (s/string) "Berlin") city`, {
        capabilities,
        config: { params: {} },
      })
    ).at(-1);
    expect(result).toBe("Berlin");
  });

  it("`overridable/resolve` remains callable directly — the macro is pure ergonomics over it", async () => {
    const [result] = await exec(`(overridable/resolve 'city (s/string) "Berlin")`, {
      capabilities,
      config: { params: { city: "Paris" } },
    });
    expect(result).toBe("Paris");
  });
});

describe("arrival/overridable — a teaching-door message survives the migration byte-for-byte", () => {
  it("a bad OVERRIDE still names the binding, the declared type, and the source", async () => {
    await expect(
      exec(`(define/overridable age (s/number) 30) age`, {
        capabilities,
        config: { params: { age: "not-a-number" } },
      }),
    ).rejects.toThrow(/define\/overridable age: expected number, got "not-a-number" \(from an environment override\)/);
  });
});

describe("arrival/overridable — the §3.4 macro firewall: `name`'s formal position never false-positives", () => {
  // Stage C Cut 2 (docs/plans/stage-c-corpse-deletion.md): the vocabulary path's default scope
  // is now a FRESH, per-call root (`LexicalScope.fresh()`, no cross-call leakage — see
  // `execStateViaVocabulary`'s own doc) — a bare `exec(code)` no longer shares top-level defines
  // with an EARLIER, unrelated `exec` call in the same process. This test's original single-call
  // shape (`(define/overridable city …) city` validated as ONE two-form program under
  // `staticValidation: "on"`) only ever passed because an EARLIER test in this same file (ROW 3,
  // above) had ALREADY bound `city` into the pre-Cut-2 realm-cached scope every no-`scope` call
  // shared — an accident of the retired cross-call sharing, not the documented firewall this
  // test names. `collectProgramDefinitions`'s Sweep 1 (static-validation/validate-program.ts)
  // only recognizes literal `define`/`define-macro`/`define-syntax` heads as program-level
  // definitions — a capability-declared `"binder"`-attributed macro like `define/overridable`
  // is NOT one of them, so a bare top-level reference to its introduced name, validated in the
  // SAME parse pass as the defining call, genuinely does not resolve (Sweep 1 has no way to know
  // `city` is coming). The FIX, using the sanctioned continuity channel (`ExecOptions.scope`,
  // not accidental realm sharing): define first (no static validation — an ordinary run),
  // THEN validate a second, later reference against the SAME scope, where `city` is an ordinary
  // already-bound SCOPE name (`vocabularyFromChain`'s `scopeNames`/`scopeLookup` — scope wins
  // over the chain), not a same-parse-pass forward reference Sweep 1 would need to predict.
  it('`define/overridable`\'s binding NAME validates clean under staticValidation: "on" (the false positive the ternary closes)', async () => {
    const scope = LexicalScope.fresh();
    await exec(`(define/overridable city (s/string) "Berlin")`, { capabilities, config: { params: {} }, scope });
    const result = (await exec(`city`, { capabilities, config: { params: {} }, scope, staticValidation: "on" })).at(-1);
    expect(result).toBe("Berlin");
  });

  it('an override still resolves clean under staticValidation: "on"', async () => {
    const scope = LexicalScope.fresh();
    const config = { params: { city: "Paris" } };
    await exec(`(define/overridable city (s/string) "Berlin")`, { capabilities, config, scope });
    const result = (await exec(`city`, { capabilities, config, scope, staticValidation: "on" })).at(-1);
    expect(result).toBe("Paris");
  });

  it("a genuinely unbound name used elsewhere in the program still reports (the firewall covers the call, not the whole program)", async () => {
    await expect(
      exec(`(define/overridable city (s/string) "Berlin") (totally-unbound-name city)`, {
        capabilities,
        config: { params: {} },
        staticValidation: "on",
      }),
    ).rejects.toThrow(/unbound/i);
  });
});

// Sanity: the boxed-state door (`execState`) still round-trips through this pack post-migration —
// mirrors `overridable.test.ts`'s own access pattern (R1), one row, not the full suite.
describe("arrival/overridable — boxed-state access still round-trips (R1 sanity, not a re-test of the baseline)", () => {
  it("execState().values still carries the resolved AString post-migration", async () => {
    async function boxedExec(code: string, options?: ExecOptions) {
      return (await execState(code, options)).values.slice();
    }
    const result = await boxedExec(`(define/overridable city (s/string) "Berlin") city`, {
      capabilities,
      config: { params: { city: "Paris" } },
    });
    expect((result.at(-1) as AString)["arrival/toJS"]()).toBe("Paris");
  });
});
