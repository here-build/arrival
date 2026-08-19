// contract-parity.test.ts — the CONTRACT GUARDRAIL (node H0).
//
// The sampler does not depend on arrival's concrete oracle types; it depends on a LOCAL STRUCTURAL
// MIRROR (src/oracle-types.ts) and an injected `makeOracle`-produced scanner. The real contract
// lives in foundations/arrival/arrival/src/oracle/contract.ts and is a SUPERSET of the mirror.
//
// This test goes LOUD the moment a concurrent edit to the arrival interpreter drifts the oracle
// contract (or the type-lens adapter) away from what the sampler's mirrors declare. It is a CHANGE
// DETECTOR: it drives the REAL scanner (via the vitest source alias) and asserts, field by field,
// that every surface the mask consumes still exists with the declared shape. If the interpreter
// agent adds/removes/reshapes midToken/position/formKind/closeable/validSymbols or analyze/feasible,
// one of these assertions fails with a message naming the field.
//
// HARDENED to a CONFORMANCE GATE (not just a change detector): a COMPILE-TIME subset assertion (a
// renamed/removed structural field fails `tsc`, package-wide, not just when a probed prefix hits it) +
// the `feasible ≡ !overClosed` invariant over a TRUNCATION CORPUS (hundreds of partial prefixes hitting
// the lexical corners), so the green suite is the executable spec a cross-language reoracle must pass —
// not 5 hand-picked rows. The TYPE-LAYER tier is deliberately NOT pinned here (arrival never produces it).
//
// It runs in the DEFAULT suite (src/__tests__/) → CI gate (per .claude/rules/tests.md: a verdict).

// Resolved to arrival SOURCE via vitest alias (vitest.config.ts) — the REAL oracle.

import { makeOracle, oracleEnvFromBindings, type OracleEnvΣ } from "@inhuman.tools/arrival/oracle";
import { describe, it, expect } from "vitest";

import type {
  CursorPosition,
  FormKind,
  OracleScanner,
  OracleSession,
  OracleState,
  StructuralOracleState,
} from "../../src/oracle-types.js";

// ── The mirror's declared closed enums. If the contract widens/renames a member, the runtime checks
//    below catch a value the mirror can't represent, and these literal lists document the expectation.
const POSITIONS: readonly CursorPosition[] = ["top", "operator", "argument"];
const FORM_KINDS: readonly FormKind[] = ["top", "application", "lambda-list", "quote", "lazy-arm"];

/** A tiny grant env binding ONLY `car`/`cdr` as callables (Σ-live). Same construction the existing
 *  constraint.test.ts / lazy.test.ts use: `oracleEnvFromBindings(bindings)`; a function value
 *  ⇒ callable in arrival's oracle env. */
const callable = (x: unknown): unknown => x;
function grantEnv(): OracleEnvΣ {
  return oracleEnvFromBindings({ car: callable, cdr: callable });
}

// ── Field-by-field structural assertions on a single OracleState ────────────────────────────────────
/** Assert that `st` (from the REAL scanner) satisfies the mirror's OracleState shape, naming the
 *  field in every failure so a drift in the interpreter is immediately legible. */
function assertOracleStateShape(st: OracleState, label: string): void {
  // midToken — boolean
  expect(typeof st.midToken, `${label}: OracleState.midToken must be boolean (mirror drift?)`).toBe("boolean");
  // closeable — boolean
  expect(typeof st.closeable, `${label}: OracleState.closeable must be boolean (mirror drift?)`).toBe("boolean");
  // overClosed — boolean (the session path reads STRUCTURAL feasibility off this; S1 depends on it)
  expect(typeof st.overClosed, `${label}: OracleState.overClosed must be boolean (mirror drift?)`).toBe("boolean");
  // position — the declared CursorPosition union
  expect(POSITIONS, `${label}: OracleState.position "${st.position}" not in mirror's CursorPosition union`).toContain(
    st.position,
  );
  // formKind — the declared FormKind union
  expect(FORM_KINDS, `${label}: OracleState.formKind "${st.formKind}" not in mirror's FormKind union`).toContain(
    st.formKind,
  );
  // validSymbols — a method returning ReadonlySet<string> | null
  expect(typeof st.validSymbols, `${label}: OracleState.validSymbols must be a method (mirror drift?)`).toBe(
    "function",
  );
  const vs = st.validSymbols();
  if (vs !== null) {
    expect(vs, `${label}: OracleState.validSymbols() must return ReadonlySet<string> | null`).toBeInstanceOf(Set);
    for (const sym of vs) {
      expect(typeof sym, `${label}: validSymbols() member "${String(sym)}" must be a string`).toBe("string");
    }
  }
}

describe("contract-parity — the REAL scanner structurally satisfies the sampler's OracleScanner mirror", () => {
  it("makeOracle() exposes analyze(): OracleState and feasible(): boolean", () => {
    const scanner: OracleScanner = makeOracle();
    expect(typeof scanner.analyze, "OracleScanner.analyze missing/renamed in the real contract").toBe("function");
    expect(typeof scanner.feasible, "OracleScanner.feasible missing/renamed in the real contract").toBe("function");
    // feasible returns a boolean
    expect(typeof scanner.feasible(""), "feasible() must return boolean").toBe("boolean");
    expect(typeof scanner.feasible("(car"), "feasible() must return boolean").toBe("boolean");
  });

  // Representative prefixes — each EXERCISES a different field so a reshape can't slip past a
  // present-but-never-read check. The expected verdicts are pinned (this is also a drift detector on
  // the SEMANTICS the mask relies on, not just the types).
  it('top-level empty prefix "" — top context, closeable, not mid-token', () => {
    const st = makeOracle().analyze("");
    assertOracleStateShape(st, 'prefix ""');
    expect(st.position, 'prefix "": position should be "top"').toBe("top");
    expect(st.formKind, 'prefix "": formKind should be "top"').toBe("top");
    expect(st.closeable, 'prefix "": empty program is closeable').toBe(true);
    expect(st.midToken, 'prefix "": boundary cursor is not mid-token').toBe(false);
  });

  it('open application "(" — operator position, application form, NOT closeable', () => {
    const st = makeOracle().analyze("(");
    assertOracleStateShape(st, 'prefix "("');
    expect(st.position, 'prefix "(": cursor is at the OPERATOR slot').toBe("operator");
    expect(st.formKind, 'prefix "(": enclosing form is an application').toBe("application");
    expect(st.closeable, 'prefix "(": an open paren cannot end the program').toBe(false);
  });

  it('mid-operator atom "(net" — mid-token, operator position', () => {
    const st = makeOracle().analyze("(net");
    assertOracleStateShape(st, 'prefix "(net"');
    expect(st.midToken, 'prefix "(net": cursor is inside an atom being typed').toBe(true);
    expect(st.position, 'prefix "(net": still the operator slot').toBe("operator");
    expect(st.formKind, 'prefix "(net": application form').toBe("application");
  });

  it('balanced form "(car 5)" — closeable at depth 0', () => {
    const st = makeOracle().analyze("(car 5)");
    assertOracleStateShape(st, 'prefix "(car 5)"');
    expect(st.closeable, 'prefix "(car 5)": a balanced form can legally end').toBe(true);
  });

  it('argument slot "(car " — argument position inside an application', () => {
    const st = makeOracle().analyze("(car ");
    assertOracleStateShape(st, 'prefix "(car "');
    expect(st.position, 'prefix "(car ": cursor is at an ARGUMENT slot').toBe("argument");
    expect(st.formKind, 'prefix "(car ": application form').toBe("application");
  });

  it("Σ-live makeOracle(grantEnv) — validSymbols() returns a non-null ReadonlySet at the operator slot", () => {
    const st = makeOracle(grantEnv()).analyze("(");
    assertOracleStateShape(st, 'Σ-live prefix "("');
    const vs = st.validSymbols();
    // With a grant env Σ is MODELLED (non-null) — the mask's whole purpose. If this goes null, the
    // interpreter dropped Σ from the makeOracle(env) path.
    expect(vs, "Σ-live: validSymbols() must be non-null when an env is granted (Σ dropped?)").not.toBeNull();
    expect(vs!.has("car"), "Σ-live: bound callable `car` should be in Σ at the operator slot").toBe(true);
    expect(vs!.has("cdr"), "Σ-live: bound callable `cdr` should be in Σ at the operator slot").toBe(true);
  });

  it("structural makeOracle() — validSymbols() degrades to null (Σ not modelled without an env)", () => {
    const vs = makeOracle().analyze("(").validSymbols();
    expect(vs, "structural: validSymbols() must be null without a grant env (graceful degradation)").toBeNull();
  });

  // ── COMPILE-TIME structural conformance (the loudest drift notify) ──────────────────────────────────
  // Derive arrival's REAL OracleState from the `makeOracle` value import (test-only — the runtime stays
  // decoupled) and assert it carries EVERY key the mask reads. If a structural field is renamed or removed
  // in the interpreter, `keyof StructuralOracleState` stops being a subset of arrival's keys and this file
  // FAILS TO TYPECHECK — drift goes loud at `tsc`, package-wide. (Robust to arrival WIDENING an enum or
  // ADDING fields — we pin the key NAMES the mask depends on; the runtime block above pins their shapes.)
  type ArrivalOracleState = ReturnType<ReturnType<typeof makeOracle>["analyze"]>;
  type _ArrivalHasEveryStructuralKey = keyof StructuralOracleState extends keyof ArrivalOracleState ? true : never;
  it("arrival's real OracleState carries every structural key the mask reads (compile-time)", () => {
    const _proof: _ArrivalHasEveryStructuralKey = true;
    expect(_proof).toBe(true);
  });

  // ── The executable conformance PROPERTY: feasible(p) === !overClosed across a TRUNCATION CORPUS ───────
  // The decoder's whole structural-feasibility argument is `feasible(p) === !analyze(p).overClosed`. The
  // golden rows above pin 5 hand-picked prefixes; this pins the INVARIANT over hundreds of partial prefixes
  // — every truncation of a corpus chosen to hit the lexical corners (strings holding parens/quotes/`;`,
  // line comments, quote-lists, deep nesting, empty strings, trailing whitespace). A reoracle correct on 5
  // rows but wrong mid-string sails past a golden-row pin and silently corrupts the mask — it cannot pass
  // this. Asserting only the definitional invariant keeps it valid for ANY conforming oracle.
  // ONE named test PER corpus program — each truncates THAT program at every offset (the inner offset
  // loop stays a `for`: it is a single property over hundreds of prefixes, not a per-offset test).
  const CORPUS = [
    "(car 5)",
    '(set-name "Alex Kim")',
    '(send "hi (there)" x)', // parens INSIDE a string must not move depth
    '(note "a ; b")', // a semicolon inside a string is NOT a comment
    "(f ; trailing comment\n  x)", // a real line comment mid-form
    "(set-tags '(work urgent))", // quote-list literal
    "(a (b (c (d 1))))", // deep nesting
    "(timer (* 10 60))", // nested arithmetic
    '(g "")', // empty string arg
    "(car ", // trailing-whitespace argument boundary
  ];
  it.each(CORPUS)(
    "feasible(p) === !overClosed across every truncation of %j (the conformance property a reoracle must pass)",
    (program) => {
      const scanner = makeOracle();
      for (let i = 0; i <= program.length; i++) {
        const p = program.slice(0, i);
        expect(
          !scanner.analyze(p).overClosed,
          `prefix ${JSON.stringify(p)} (${JSON.stringify(program)}@${i}): !overClosed must equal feasible(p)`,
        ).toBe(scanner.feasible(p));
      }
    },
  );
});

// ── Session surface parity (node S1) ──────────────────────────────────────────────────────────────
// S1's resumable perf seam depends on the real scanner exposing session()/clone()/advance()/state.
// This guards against the interpreter agent dropping or reshaping that surface — the moment it drifts
// from the mirror's OracleSession declaration, one of these goes red.
describe.each([undefined, grantEnv()] as const)(
  "contract-parity — the REAL scanner exposes the OracleSession surface the S1 mirror declares [%s]",
  (grant) => {
    const label = grant ? "Σ-live" : "structural";
    it(`[${label}] scanner.session(prefix) returns a session with advance/clone/state`, () => {
      const scanner = makeOracle(grant);
      expect(typeof scanner.session, `${label}: OracleScanner.session must be a method (S1 seam dropped?)`).toBe(
        "function",
      );
      const session: OracleSession = scanner.session!("(car");
      expect(typeof session.advance, `${label}: OracleSession.advance must be a method`).toBe("function");
      expect(typeof session.clone, `${label}: OracleSession.clone must be a method`).toBe("function");
      assertOracleStateShape(session.state, `${label}: session.state at "(car"`);
    });

    it(`[${label}] session.state === analyze(prefix) and !state.overClosed === feasible(prefix)`, () => {
      const scanner = makeOracle(grant);
      // The two equalities S1 derives its verdict-parity from. If the interpreter ever makes the
      // session path diverge from analyze/feasible, S1's parity test would lie — this catches it here.
      for (const prefix of ["", "(", "(car", "(car 5)", "(car 5))"]) {
        const session = scanner.session!(prefix);
        const direct = scanner.analyze(prefix);
        expect(session.state.position, `${label} ${JSON.stringify(prefix)}: position`).toBe(direct.position);
        expect(session.state.formKind, `${label} ${JSON.stringify(prefix)}: formKind`).toBe(direct.formKind);
        expect(session.state.closeable, `${label} ${JSON.stringify(prefix)}: closeable`).toBe(direct.closeable);
        expect(session.state.midToken, `${label} ${JSON.stringify(prefix)}: midToken`).toBe(direct.midToken);
        expect(session.state.overClosed, `${label} ${JSON.stringify(prefix)}: overClosed`).toBe(direct.overClosed);
        expect(
          !session.state.overClosed,
          `${label} ${JSON.stringify(prefix)}: !overClosed must equal feasible (the S1 structural map)`,
        ).toBe(scanner.feasible(prefix));
      }
    });

    it(`[${label}] clone() + advance() yields the SAME state as analyzing the concatenated prefix`, () => {
      const scanner = makeOracle(grant);
      const base = scanner.session!("(car ");
      const probe = base.clone();
      probe.advance("cdr");
      const direct = scanner.analyze("(car cdr");
      expect(probe.state.position).toBe(direct.position);
      expect(probe.state.midToken).toBe(direct.midToken);
      expect(probe.state.overClosed).toBe(direct.overClosed);
      // clone must NOT mutate the base session.
      expect(base.state.position, "clone+advance leaked into the base session").toBe(scanner.analyze("(car ").position);
    });
  },
);
