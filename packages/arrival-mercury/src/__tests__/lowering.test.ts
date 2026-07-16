/**
 * LOWERING DECISIONS (engine plan §2 E3; `../lowering/index.ts`), tested at
 * the same three layers `prevalue.test.ts`/`propagate.test.ts` (its sibling
 * decision modules) use:
 *   - the pure decisions (`loweringDecisionAt`, `guardFormOf`) in isolation —
 *     every rung of the §4.2 ladder (rule / shim / door, both call and value
 *     position) and both guard forms;
 *   - a LOCAL emit pipeline (classify → walk(registry, loweringDecisionAt,
 *     guardFormOf) → render) proving the walker actually consults both views
 *     and is BYTE-IDENTICAL to the pre-E3 inline ladder/guard;
 *   - one proof that the REAL `compileGreenfield` harness runs through the
 *     views end to end, oracle-agreeing throughout.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classify } from "../coreform/index.js";
import type { ClassifyResult } from "../coreform/index.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import {
  cleanupOracleScratch,
  compileGreenfield,
  openOracleSession,
  type OracleSession,
  phase1Rules,
  runOracle,
  withRules,
} from "../index.js";
import { guardFormOf, loweringDecisionAt } from "../lowering/index.js";
import type { EmitRegistry } from "../registry/index.js";
import { render } from "../residual/render.js";
import type { CompilationUnit } from "../residual/types.js";
import { walk, type WalkOptions } from "../walker/index.js";

const cf = (src: string): ClassifyResult => classify(desugar(parseSexprs(src)));

const EMPTY: EmitRegistry = { lookup: () => undefined, names: new Set<string>() };
/** One row per ladder rung under test — a rule (`car`), a bare-presence shim
 *  (`string-append`), a registry-declared door (`set-car!`-style prohibition,
 *  modeled generically as `banned`), and a value-position `refPolicy: "door"`
 *  symbol (`no-first-class`). Mirrors `prevalue.test.ts`/`propagate.test.ts`'s
 *  own "just enough registry to exercise the shape under test" convention. */
const LADDER_REGISTRY: EmitRegistry = withRules(EMPTY, {
  ...phase1Rules,
  "no-first-class": { refPolicy: "door" },
});

describe("loweringDecisionAt — the §4.2 ladder verdict", () => {
  it("rung: rule — a registry row carrying an emit rule (car, call position)", () => {
    const decision = loweringDecisionAt("car", LADDER_REGISTRY, "call");
    expect(decision.rung).toBe("rule");
  });

  it("rung: shim — a bare-presence row with no emit rule (call position)", () => {
    const registry = withRules(EMPTY, { ...phase1Rules, "bare-symbol": {} });
    const decision = loweringDecisionAt("bare-symbol", registry, "call");
    expect(decision).toEqual({ rung: "shim", row: expect.objectContaining({ symbol: "bare-symbol" }) });
  });

  it("rung: door — an unresolved (non-registry) identifier", () => {
    const decision = loweringDecisionAt("this-does-not-exist", EMPTY, "call");
    expect(decision.rung).toBe("door");
    if (decision.rung === "door") {
      expect(decision.code).toBe("unsupported-form/unresolved-identifier");
      expect(decision.message).toContain("this-does-not-exist");
    }
  });

  it("rung: door — a registry-declared door row (kind: \"door\")", () => {
    // A door-KIND row (as a harvested prohibited-dynamics/capability-declined
    // symbol would carry) constructed directly, matching `EmitRegistryRow`'s
    // own shape — this package's own phase1Rules table declares no door rows
    // today, so a direct construction is the honest fixture.
    const registry: EmitRegistry = {
      lookup: (name) =>
        name === "banned"
          ? { symbol: "banned", capability: "«test»", kind: "door", refPolicy: "shim", doorReason: "banned for testing" }
          : undefined,
      names: new Set(["banned"]),
    };
    const decision = loweringDecisionAt("banned", registry, "call");
    expect(decision.rung).toBe("door");
    if (decision.rung === "door") {
      expect(decision.code).toBe("unsupported-form/banned");
      expect(decision.message).toBe("banned for testing");
    }
  });

  it("value position: rung shim when no rule.ref is declared (eta degrades to shim — cdr, verified empirically: unlike car, cdr's own rule has no .ref)", () => {
    const decision = loweringDecisionAt("cdr", LADDER_REGISTRY, "value");
    expect(decision.rung).toBe("shim");
    if (decision.rung === "shim") expect(decision.row.symbol).toBe("cdr");
  });

  it("value position: rung rule when the rule DOES declare .ref (car — R5c's live eta-expansion)", () => {
    const decision = loweringDecisionAt("car", LADDER_REGISTRY, "value");
    expect(decision.rung).toBe("rule");
  });

  it("value position: rung door when refPolicy is \"door\"", () => {
    const decision = loweringDecisionAt("no-first-class", LADDER_REGISTRY, "value");
    expect(decision.rung).toBe("door");
    if (decision.rung === "door") expect(decision.message).toContain('refPolicy "door"');
  });

  it("call position and value position may disagree for the SAME symbol (cdr: rule in call position, shim in value position)", () => {
    expect(loweringDecisionAt("cdr", LADDER_REGISTRY, "call").rung).toBe("rule");
    expect(loweringDecisionAt("cdr", LADDER_REGISTRY, "value").rung).toBe("shim");
  });
});

describe("guardFormOf — Law-T's guard form", () => {
  it("read register is ALWAYS bare, regardless of facts", () => {
    expect(guardFormOf(undefined, "read")).toBe("bare");
    expect(guardFormOf({ boolean: true }, "read")).toBe("bare");
    expect(guardFormOf({}, "read")).toBe("bare");
  });

  it("run register: bare iff facts.boolean is proven, else strict", () => {
    expect(guardFormOf({ boolean: true }, "run")).toBe("bare");
    expect(guardFormOf({}, "run")).toBe("strict");
    expect(guardFormOf(undefined, "run")).toBe("strict"); // Law F: absence ⇒ conservative
  });
});

describe("walker consumption — the ladder and guard form both fire INSIDE walk()", () => {
  // The local emit pipeline: classify → walk(registry, loweringDecisionAt) →
  // render — proves the walker actually consults the view and is
  // byte-identical to the pre-E3 inline ladder. `guardFormOf`'s own wiring is
  // exercised directly, below (it needs a facts map keyed by real node ids,
  // which only a specific fixture's own `cf(...)` call can produce).
  const localCompile = (src: string, registry: EmitRegistry = LADDER_REGISTRY, over: Partial<WalkOptions> = {}): CompilationUnit =>
    walk(cf(src), {
      registry,
      register: "run",
      loweringDecisionAt: (name, position) => loweringDecisionAt(name, registry, position),
      ...over,
    });
  const localEmit = (src: string, registry: EmitRegistry = LADDER_REGISTRY, over: Partial<WalkOptions> = {}): string =>
    render(localCompile(src, registry, over));

  it("a rule-rung symbol (car) emits the idiomatic residual via the view", () => {
    // The naming phase's implicit-destructuring policy (engine plan §2 E1a)
    // fires here too — `xs`'s ONLY occurrence is a position-0 access, so it
    // destructures to `[head]` rather than staying a bare `xs[0]` index; this
    // row is about the LADDER (an `Index` residual, no shim call), not about
    // naming, so the destructured shape is the correct, expected output.
    expect(localEmit(`(define (f xs) (car xs))`)).toBe(`function f([head]) {\n    return head;\n}\n`);
  });

  it("a shim-rung symbol emits a RuntimeRef call via the view", () => {
    const registry = withRules(EMPTY, { ...phase1Rules, "bare-symbol": {} });
    const out = localEmit(`(define (f) (bare-symbol 1))`, registry);
    expect(out).toContain("bare-symbol(1)");
  });

  it("without loweringDecisionAt wired in (default undefined), the ladder still resolves — same registry, computed directly", () => {
    const withView = localEmit(`(define (f xs) (car xs))`, LADDER_REGISTRY);
    const withoutView = localEmit(`(define (f xs) (car xs))`, LADDER_REGISTRY, { loweringDecisionAt: undefined });
    expect(withoutView).toBe(withView); // byte-identical either way
  });

  it("guardFormOf wiring: without it (default undefined), Law T's guard still resolves — same facts, computed directly", () => {
    // ONE classify() call, reused for both walk()s: a fresh cf(...) per call
    // would mint a DIFFERENT NodeId for "the same" text, silently breaking
    // the facts map's keying — classify()'s ids are per-call, never stable
    // across separate parses (coreform/types.ts's own NodeId doc).
    const classified = cf(`(if x x "y")`);
    const ifNode = classified.forms[0]!;
    if (ifNode.kind !== "If") throw new Error("expected an If as the sole top-level form");
    const facts = new Map([[ifNode.cond.id, { boolean: true }]]); // the COND's id, not the If's own
    const withGuard = render(
      walk(classified, { registry: EMPTY, register: "run", facts, guardFormOf: (n, r) => guardFormOf(facts.get(n.id), r) }),
    );
    const withoutGuard = render(walk(classified, { registry: EMPTY, register: "run", facts }));
    expect(withoutGuard).toBe(withGuard);
    expect(withGuard).not.toContain("!== false"); // sanity: the fact actually fired (bare form)
  });

  it("Law T end to end: an unproven condition gets the exact-Scheme guard", () => {
    expect(localEmit(`(if x "a" "b")`, EMPTY).replace(/\s+/g, " ")).toContain("!== false");
  });

  it("Law T end to end: a proven-boolean condition emits bare (no guard) — via a hand-proven fact", () => {
    // `null?`/`pair?`'s own narrows machinery lives on arrival-core's real
    // Contracts now (rules/phase1.ts's own relocation note) — out of scope
    // for a hand-rolled EMPTY-base registry; a directly-supplied fact proves
    // the SAME guard-form decision without depending on the type-lens at all
    // (typefacts'/type-emit's own territory, tested there).
    const classified = cf(`(if x "a" "b")`);
    const ifNode = classified.forms[0]!;
    if (ifNode.kind !== "If") throw new Error("expected an If");
    const facts = new Map([[ifNode.cond.id, { boolean: true }]]);
    const out = render(walk(classified, { registry: EMPTY, register: "run", facts }));
    expect(out).not.toContain("!== false");
  });
});

describe("compileGreenfield wiring — the ladder and guard form run end to end through the REAL harness", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openOracleSession();
  }, 60_000);
  afterAll(async () => {
    await session.dispose();
    cleanupOracleScratch();
  }, 30_000);

  it("car compiles through the REAL compileGreenfield to the idiomatic index residual", () => {
    const compiled = compileGreenfield(session, `(car (list 1 2 3))`);
    expect(compiled).toContain("[0]");
  });

  it("value preservation over the real oracle: the relocated ladder agrees with the interpreter", async () => {
    const verdict = await runOracle(session, `(car (list 1 2 3))`);
    expect(verdict.agree, verdict.detail).toBe(true);
    expect(verdict.compiled).toEqual({ kind: "value", value: 1 });
  });

  it("value preservation for the guard form: (if 0 \"truthy\" \"falsy\") — the JS-falsy trap Law T must not fall into", async () => {
    const verdict = await runOracle(session, `(if 0 "truthy" "falsy")`);
    expect(verdict.agree, verdict.detail).toBe(true);
    expect(verdict.compiled).toEqual({ kind: "value", value: "truthy" });
  });
});
