/**
 * THE SHAKE (engine plan §2 E3; `../shake/index.ts`), tested at the same
 * three layers `prevalue.test.ts`/`propagate.test.ts` (its sibling decision
 * modules) use:
 *   - the pure decision (`shakeTopLevel`) at the CoreForm-shape layer —
 *     RED-FIRST: a dead pure define is pruned; a dead EFFECTFUL top-level is
 *     KEPT (the mission's own two worked cases, `infer` vs `string-append`);
 *   - a LOCAL emit pipeline (classify → walk(registry, shakeOf) → render)
 *     proving the walker actually consults the view and a pruned define's
 *     lines never reach the emitted artifact;
 *   - one proof that the REAL `compileGreenfield` harness shakes the oracle
 *     wrapper's own body end to end, oracle-agreeing throughout (a pruned OR
 *     effect-kept define never changes the program's observable value).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classify } from "../coreform/index.js";
import type { ClassifyResult } from "../coreform/index.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import {
  cleanupOracleScratch,
  compileGreenfield,
  emitRegistryOf,
  openOracleSession,
  type OracleSession,
  phase1Rules,
  runOracle,
  withRules,
} from "../index.js";
import type { EmitRegistry } from "../registry/index.js";
import { render } from "../residual/render.js";
import type { CompilationUnit } from "../residual/types.js";
import { shakeTopLevel } from "../shake/index.js";
import { walk, type WalkOptions } from "../walker/index.js";

const cf = (src: string): ClassifyResult => classify(desugar(parseSexprs(src)));

// ── registries: a bare presence row per symbol under test — the identical
// convention prevalue.test.ts/propagate.test.ts already use (just enough for
// the walker to resolve the symbol; provenance/cacheClass come through
// verbatim from the harvested Contract when a real session is available). ──
const EMPTY: EmitRegistry = { lookup: () => undefined, names: new Set<string>() };
/** `string-append` — PIPE provenance (the native default): the DEAD_DEFINE-
 *  style pure case. `infer` — SOURCE provenance, "pure" cacheClass (the
 *  worked contrast `../shake/index.ts`'s own header names): effectful for
 *  shake purposes despite being CSE-eligible. `map` — FAN provenance: the
 *  deliberately-conservative "keep if dead" bucket (module header). */
const PROVENANCE_REGISTRY: EmitRegistry = {
  lookup: (name) => {
    const rows: Record<string, { provenance?: "pipe" | "source" | "fan" | "sink" | "opaque" }> = {
      "string-append": { provenance: "pipe" },
      car: {},
      infer: { provenance: "source" },
      map: { provenance: "fan" },
      write: { provenance: "sink" },
    };
    const row = rows[name];
    return row === undefined
      ? undefined
      : { symbol: name, capability: "«test»", kind: "native", refPolicy: "shim", ...row };
  },
  names: new Set(["string-append", "car", "infer", "map", "write"]),
};

// ── the local emit pipeline: classify → walk(registry, shakeOf) → render —
// mirrors prevalue.test.ts/propagate.test.ts's own `compile`/`emit` helpers,
// with the shake wired in exactly where oracle/harness.ts's compileGreenfield
// wires it (applied to the SAME top-level forms list `walk()` itself sees).
const compile = (src: string, registry: EmitRegistry = PROVENANCE_REGISTRY, over: Partial<WalkOptions> = {}): CompilationUnit =>
  walk(cf(src), {
    registry,
    register: "run",
    shakeOf: (forms) => shakeTopLevel(forms, registry),
    ...over,
  });
const emit = (src: string, registry: EmitRegistry = PROVENANCE_REGISTRY, over: Partial<WalkOptions> = {}): string =>
  render(compile(src, registry, over));

describe("shakeTopLevel — the pure decision", () => {
  it("RED: a dead PURE define is pruned (string-append — pipe provenance)", () => {
    const { forms } = cf(`(define used (infer "live" "u"))
(define unused (string-append "never" "read"))
(infer "out" (car used))`);
    const decision = shakeTopLevel(forms, PROVENANCE_REGISTRY);
    expect(decision.pruned.map((e) => e.name)).toEqual(["unused"]);
    expect(decision.keptForEffect).toEqual([]);
    expect(decision.forms).toHaveLength(2); // `unused` gone; `used` + the trailing infer survive
    expect(decision.forms.some((f) => "name" in f && f.name === "unused")).toBe(false);
  });

  it("RED: a dead EFFECTFUL define (infer — source provenance) is KEPT, not pruned", () => {
    const { forms } = cf(`(define used (infer "live" "u"))
(define unused-effect (infer "side" "never-referenced"))
(infer "out" (car used))`);
    const decision = shakeTopLevel(forms, PROVENANCE_REGISTRY);
    expect(decision.pruned).toEqual([]);
    expect(decision.keptForEffect.map((e) => e.name)).toEqual(["unused-effect"]);
    expect(decision.forms).toBe(forms); // identity fast path — nothing REMOVED, even though something is dead
    expect(decision.forms).toHaveLength(3);
  });

  it("a dead define reaching an effectful call NESTED several levels deep is still kept (whole-subtree scan)", () => {
    const { forms } = cf(`(define (helper x) (string-append "wrap:" (car (list x))))
(define unused (helper (infer "buried" "deep")))
(infer "out" "done")`);
    const decision = shakeTopLevel(forms, PROVENANCE_REGISTRY);
    expect(decision.pruned).toEqual([]);
    // `unused` survives on its own effect; `helper` survives BECAUSE `unused`
    // (kept) still calls it — see the dedicated soundness row below.
    expect(decision.keptForEffect.map((e) => e.name).sort()).toEqual(["helper", "unused"]);
  });

  it("SOUNDNESS: an otherwise-dead-and-PURE define referenced ONLY by a dead-but-effectful sibling survives too — pruning it would dangle the sibling's own reference", () => {
    const { forms } = cf(`(define (helper x) (string-append "wrap:" (car (list x))))
(define unused (helper (infer "buried" "deep")))
"root"`);
    const decision = shakeTopLevel(forms, PROVENANCE_REGISTRY);
    expect(decision.pruned).toEqual([]); // neither survives on ROOT-reachability (there is none)…
    // …but BOTH survive: `unused` on its own effect, `helper` because `unused` (kept) still calls it.
    expect(decision.keptForEffect.map((e) => e.name).sort()).toEqual(["helper", "unused"]);
    expect(decision.forms).toBe(forms); // identity fast path — nothing was actually removed
  });

  it("conservative bucket: a dead define whose only call is FAN-provenance (map) is kept, not pruned", () => {
    const { forms } = cf(`(define xs (list 1 2 3))
(define unused (map car xs))
(car xs)`);
    const decision = shakeTopLevel(forms, PROVENANCE_REGISTRY);
    expect(decision.pruned).toEqual([]);
    expect(decision.keptForEffect.map((e) => e.name)).toEqual(["unused"]);
  });

  it("mutual recursion: two dead pure defines referencing only each other are BOTH pruned", () => {
    const { forms } = cf(`(define (ping n) (if (car n) (pong n) n))
(define (pong n) (ping n))
"alive"`);
    const decision = shakeTopLevel(forms, PROVENANCE_REGISTRY);
    expect(decision.pruned.map((e) => e.name).sort()).toEqual(["ping", "pong"]);
  });

  it("mutual recursion reachable from a root: BOTH survive", () => {
    const { forms } = cf(`(define (ping n) (if (car n) (pong n) n))
(define (pong n) (ping n))
(ping (list #t))`);
    const decision = shakeTopLevel(forms, PROVENANCE_REGISTRY);
    expect(decision.pruned).toEqual([]);
  });

  it("a non-define root (a bare expression) is never a pruning candidate", () => {
    const { forms } = cf(`(string-append "a" "b")`);
    const decision = shakeTopLevel(forms, PROVENANCE_REGISTRY);
    expect(decision.forms).toBe(forms);
    expect(decision.pruned).toEqual([]);
  });

  it("requires are never pruned this wave, even when unreferenced (conservative, documented no-op)", () => {
    const { forms } = cf(`(require "some-module")
(string-append "a" "b")`);
    const decision = shakeTopLevel(forms, PROVENANCE_REGISTRY);
    expect(decision.forms).toBe(forms);
    expect(decision.pruned).toEqual([]);
  });

  it("redefinition (a name defined more than once) is never pruned — declines entirely, matching propagateTopLevelDefines", () => {
    const { forms } = cf(`(define x (string-append "a" "b"))
(define x (string-append "c" "d"))
(car (list x))`);
    const decision = shakeTopLevel(forms, PROVENANCE_REGISTRY);
    expect(decision.pruned).toEqual([]);
  });

  it("identity fast path: nothing to prune returns the SAME forms array", () => {
    const { forms } = cf(`(define used (string-append "a" "b"))
(car (list used))`);
    expect(shakeTopLevel(forms, PROVENANCE_REGISTRY).forms).toBe(forms);
  });

  it("no defines at all: identity, no crash", () => {
    const { forms } = cf(`(string-append "a" "b")`);
    const decision = shakeTopLevel(forms, EMPTY);
    expect(decision.forms).toBe(forms);
    expect(decision.pruned).toEqual([]);
    expect(decision.keptForEffect).toEqual([]);
  });

  it("an unresolved (non-registry) symbol name is treated as pure — Law F's safe default, matching NO_OWN_CROSSING's `undefined` case", () => {
    const { forms } = cf(`(define unused (totally-unregistered-symbol "x"))
"done"`);
    const decision = shakeTopLevel(forms, EMPTY);
    expect(decision.pruned.map((e) => e.name)).toEqual(["unused"]);
  });
});

describe("walker consumption — the shake fires INSIDE walk() (engine plan §2 E3)", () => {
  // These fixtures are top-level (program-scope) sibling lists — the shake
  // hook `walk()` wires in operates on `classified.forms` itself (module
  // header: "at the SAME point propagateTopLevelDefines already runs"), not
  // inside a nested function's own body. Same shapes as the pure-decision
  // rows above, run through the FULL local pipeline (walk + render).

  it("a dead pure top-level define's binding never reaches the emitted artifact", () => {
    const out = emit(`(define used (string-append "a" "b"))
(define unused (string-append "c" "d"))
used`);
    expect(out).not.toContain("unused");
  });

  it("without shakeOf wired in (default undefined), the dead define is NOT pruned — byte-identical to pre-E3", () => {
    const out = emit(
      `(define used (string-append "a" "b"))
(define unused (string-append "c" "d"))
used`,
      PROVENANCE_REGISTRY,
      { shakeOf: undefined },
    );
    expect(out).toContain("unused");
  });

  it("a dead EFFECTFUL top-level define survives inside walk() too — it still compiles, just unreferenced", () => {
    const out = emit(`(define used (infer "live" "u"))
(define unused-effect (infer "side" "x"))
(car used)`);
    expect(out).toContain("unused");
    expect(out).toContain("infer");
  });
});

describe("compileGreenfield wiring — the shake runs end to end through the REAL harness (oracle-agreeing)", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openOracleSession();
  }, 60_000);
  afterAll(async () => {
    await session.dispose();
    cleanupOracleScratch();
  }, 30_000);

  it("a dead pure top-level define is pruned from the REAL compiled artifact", () => {
    const source = `(define used (string-append "a" "b"))
(define unused (string-append "c" "d"))
used`;
    const compiled = compileGreenfield(session, source);
    expect(compiled).not.toContain('"c"');
    expect(compiled).not.toContain("unused");
  });

  it("value preservation over the real oracle: the shaken program still agrees with the interpreter", async () => {
    const source = `(define used (string-append "a" "b"))
(define unused (string-append "c" "d"))
used`;
    const verdict = await runOracle(session, source);
    expect(verdict.agree, verdict.detail).toBe(true);
    expect(verdict.compiled).toEqual({ kind: "value", value: "ab" });
  });

  // NOTE: `infer` cannot be EXECUTED through this session (`openOracleSession`'s
  // stub throws unconditionally outside the async-family cell — see that
  // function's own doc); every row below uses `compileGreenfield` (a pure
  // compile — classify/facts/walk/render, nothing runs) rather than
  // `runOracle`/`evalCompiled`, matching `propagate.test.ts`'s own identical
  // precedent for its own infer-touching "compileGreenfield wiring" rows.

  it("a dead EFFECTFUL top-level define (infer) SURVIVES the real compile, unreferenced — the red-first KEPT case", () => {
    const source = `(define used (infer "live" "u"))
(define unused-effect (infer "side" "never-referenced"))
(car used)`;
    const compiled = compileGreenfield(session, source);
    expect(compiled).toContain("unusedEffect"); // survives, allocated a real name
    expect(compiled.match(/infer\(/g)?.length).toBe(2); // both infer calls still present
  });

  it("the REAL harvested registry classifies infer as effectful for the shake (empirical, not assumed)", () => {
    const registry = emitRegistryOf(session.ambient);
    const row = withRules(registry, phase1Rules).lookup("infer");
    expect(row?.provenance).toBe("source");
  });
});
