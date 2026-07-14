/**
 * Law-U diagnostics (constitution §5.2 Law U; Appendix B "car/cdr on empty"):
 * `(car '())`, `(cdr '())`, and an out-of-range access reached by composing them
 * are R7RS "is an error" forms — OUTSIDE the compilation contract. They compile
 * CLEAN through `compileGreenfield` (the bare representation-collapsed shape,
 * unconditionally — no guard, no throw machinery), and their COMPILED runtime
 * behavior is whatever the representation does (`[][0]` → `undefined`).
 *
 * This is a DISJOINT corpus from the oracle's defined-programs corpus
 * (constitution §5.4: "the oracle corpus contains only defined programs; UB
 * forms live in a diagnostics check set") — per-side documentation assertions,
 * never an oracle row (never `runOracle`/`agreementOf`), because the two sides
 * are not asserted to agree here.
 *
 * INTERPRETER SIDE — verified empirically (2026-07-14, this session), NOT the
 * "is an error ⇒ throws" assumption Law U's R7RS citation might suggest: `car`/
 * `cdr` are deliberately TOLERANT on nil, returning nil itself rather than
 * throwing — a documented ruling (`foundations/arrival/arrival/src/env/r7rs/
 * equality.ts`'s `null?` comment: "a model writing `(if (null? results) "none"
 * (car results)) ... called `(car [])`, got a tolerant nil"` — describing car's
 * own behavior, not a bug `null?` needs to route around). So BOTH sides are
 * TOTAL over this UB form (neither throws) — R7RS licenses either an error OR
 * an implementation-defined answer, and this interpreter picked "tolerant nil."
 * The two implementation-defined answers do not have to (and mostly don't)
 * AGREE with the artifact's representation-collapsed answer: `car` diverges
 * (`undefined` vs nil-as-`[]`); `cdr` happens to coincide (both project to
 * `[]`, for unrelated reasons — JS's empty-slice vs Scheme's tolerant-nil).
 * Each assertion below documents its OWN side; no cross-side equality is
 * asserted, and the per-row comment says which way it actually landed.
 *
 * `list-ref` (R7RS's canonical out-of-range example, and the mission's naming)
 * is deliberately NOT the literal subject here: it is a registered arrival
 * native (`foundations/arrival/arrival/src/env/r7rs/lists.ts`) with no
 * `phase1Rules` emit rule and no `STAGE0` manifest row (verified against
 * `src/runtime/stage0.ts`) — a compiled call would DOOR at FRAME
 * (`FrameDoorError`, "not supported by the runtime module yet"), not compile
 * clean. The out-of-range CASE Law U describes is reached instead compositionally
 * through car/cdr — `(car (cdr '(1)))` lands at the same `[][0]` cell a
 * `list-ref` overrun would, while staying inside the representation-collapsed
 * rules that actually compile clean today.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { cleanupOracleScratch, compileGreenfield, evalCompiled, evalInterpreter, openOracleSession } from "../index.js";
import type { OracleSession } from "../index.js";

interface Subject {
  readonly name: string;
  readonly source: string;
  /** Substring the emitted body must contain — the bare representation shape. */
  readonly shape: string;
  readonly compiledValue: unknown;
  /** The interpreter's OWN (tolerant-nil) answer, JS-face-projected. */
  readonly interpreterValue: unknown;
  /** Whether the two sides' values happen to coincide — documented, not required. */
  readonly sidesAgree: boolean;
}

const SUBJECTS: readonly Subject[] = [
  {
    name: "(car '()) — empty-list car",
    source: `(car '())`,
    shape: "[][0]",
    compiledValue: undefined,
    interpreterValue: [], // tolerant nil, JS-face-projected
    sidesAgree: false, // undefined ≠ []
  },
  {
    name: "(cdr '()) — empty-list cdr",
    source: `(cdr '())`,
    shape: "[].slice(1)",
    compiledValue: [],
    interpreterValue: [], // tolerant nil-of-nil, JS-face-projected
    sidesAgree: true, // both [] — coincidence of two unrelated totalities, not a law
  },
  {
    name: "(car (cdr '(1))) — out-of-range access reached compositionally",
    source: `(car (cdr '(1)))`,
    shape: "[1].slice(1)[0]",
    compiledValue: undefined,
    interpreterValue: [], // (cdr '(1)) → nil (correct), then tolerant car-of-nil → nil
    sidesAgree: false, // undefined ≠ []
  },
];

/** No guard, no throw machinery: the representation-collapsed rules (`car`/`cdr`)
 *  never branch on their operand — this is the "outside the contract, so nothing
 *  is emitted to police it" half of Law U, checked at the TEXT level. */
function hasNoGuardMachinery(compiled: string): boolean {
  return !/\bthrow\b/.test(compiled) && !/\bif\s*\(/.test(compiled);
}

describe("Law U — undefined-behavior forms compile clean, run representation-native (constitution §5.2)", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openOracleSession();
  }, 120_000);
  afterAll(async () => {
    await session.dispose();
    cleanupOracleScratch();
  });

  for (const subject of SUBJECTS) {
    describe(subject.name, () => {
      it("compiles to the bare representation-collapsed shape — no guard, no throw machinery", () => {
        const compiled = compileGreenfield(session, subject.source);
        expect(compiled, compiled).toContain(subject.shape);
        expect(hasNoGuardMachinery(compiled), compiled).toBe(true);
      });

      it("compiled side: the representation's own answer, never a throw", async () => {
        const outcome = await evalCompiled(session, subject.source);
        expect(outcome).toEqual({ kind: "value", value: subject.compiledValue });
      });

      it("interpreter side: its own (tolerant-nil) answer, never a throw", async () => {
        const outcome = await evalInterpreter(session, subject.source);
        expect(outcome).toEqual({ kind: "value", value: subject.interpreterValue });
      });

      it(`documents whether the two sides' totalities ${subject.sidesAgree ? "coincide" : "diverge"} — informational, not a law`, async () => {
        const compiled = await evalCompiled(session, subject.source);
        const interpreter = await evalInterpreter(session, subject.source);
        const bothValues = compiled.kind === "value" && interpreter.kind === "value";
        expect(bothValues).toBe(true);
        if (compiled.kind === "value" && interpreter.kind === "value") {
          expect(JSON.stringify(compiled.value) === JSON.stringify(interpreter.value)).toBe(subject.sidesAgree);
        }
      });
    });
  }

  // Placeholder — the lens's compile-time "unproven car" WARNING (constitution
  // §5.2: "the lens WARNS at compile time on unproven car use") is the types
  // track's diagnostic surface, not this package's. Named here so the obligation
  // is not lost, without inventing today's (unbuilt) diagnostic API.
  it.todo("the lens warns at compile time on an unproven `car` use — types track owns the diagnostic surface");
});
