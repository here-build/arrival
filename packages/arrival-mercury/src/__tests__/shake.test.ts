/**
 * THE SHAKE (engine plan §2 E3; `../shake/index.ts`), tested at the same
 * three layers `prevalue.test.ts`/`propagate.test.ts` (its sibling decision
 * modules) use:
 *   - the pure decision (`shakeTopLevel`) at the CoreForm-shape layer —
 *     RED-FIRST: a dead pure define is pruned; a dead EFFECTFUL top-level is
 *     KEPT (the mission's own two worked cases, `infer` vs `string-append`);
 *   - a LOCAL emit pipeline (classify → walk(registry, shakeOf) → render)
 *     proving the walker actually consults the view and a pruned define's
 *     lines never reach the emitted artifact.
 *
 * (A former third layer proved the shake end to end through the real oracle
 * harness, oracle-agreeing throughout; it depended on the oracle package and
 * was removed to keep this a pure compiler unit test.)
 */
import { describe, expect, it } from "vitest";

import {
  classify,
  desugar,
  parseSexprs,
  walk,
} from "../index.js";
import type { ClassifyResult, EmitRegistry, WalkOptions } from "../index.js";
import { render } from "../residual/render.js";
import type { CompilationUnit } from "../residual/types.js";
import { shakeTopLevel } from "../shake/index.js";

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
// with the shake wired in exactly where oracle/harness.ts's real compile harness
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

// ── the pure-decision protocol table: one row per behavior claim ───────────
// Every row runs `cf(src)` → `shakeTopLevel(forms, registry)` and then makes
// exactly the assertions its fields describe — an ABSENT optional field is an
// assertion the original it never made (omitted, never defaulted: no
// strengthening), and a present field runs the original assertion verbatim
// (no weakening). The optional flags are the file's own assertion vocabulary,
// one per assertion shape the its used. Assertion order inside the runner is
// canonical (pruned → keptForEffect → identity → formsLength → absent-from-
// forms); the identity-first rows assert the same SET either way.
interface ShakeCase {
  /** The behavior claim — becomes the it name. */
  readonly name: string;
  readonly src: string;
  /** Registry override — defaults to PROVENANCE_REGISTRY; the Law F rows use EMPTY. */
  readonly registry?: EmitRegistry;
  /** Expected `decision.pruned` names — compared in decision order, or
   *  order-insensitively under `sort` (rows whose original assertion .sort()ed:
   *  decision ORDER is not under test there). */
  readonly pruned?: readonly string[];
  /** Expected `decision.keptForEffect` names — same ordering rules as `pruned`. */
  readonly keptForEffect?: readonly string[];
  /** The original assertion .sort()ed the name list before comparing. */
  readonly sort?: boolean;
  /** Assert the identity fast path: `decision.forms` IS the input array. */
  readonly identity?: boolean;
  /** Extra assertion on the surviving forms count. */
  readonly formsLength?: number;
  /** Belt-and-braces follow-through: no surviving form carries any pruned name. */
  readonly prunedAbsentFromForms?: boolean;
}

const SHAKE_CASES: readonly ShakeCase[] = [
  {
    name: "RED: a dead PURE define is pruned (string-append — pipe provenance)",
    src: `(define used (infer "live" "u"))
(define unused (string-append "never" "read"))
(infer "out" (car used))`,
    pruned: ["unused"],
    keptForEffect: [],
    // `unused` gone; `used` + the trailing infer survive
    formsLength: 2,
    prunedAbsentFromForms: true,
  },
  {
    name: "RED: a dead EFFECTFUL define (infer — source provenance) is KEPT, not pruned",
    src: `(define used (infer "live" "u"))
(define unused-effect (infer "side" "never-referenced"))
(infer "out" (car used))`,
    pruned: [],
    keptForEffect: ["unused-effect"],
    identity: true, // identity fast path — nothing REMOVED, even though something is dead
    formsLength: 3,
  },
  {
    name: "a dead define reaching an effectful call NESTED several levels deep is still kept (whole-subtree scan)",
    src: `(define (helper x) (string-append "wrap:" (car (list x))))
(define unused (helper (infer "buried" "deep")))
(infer "out" "done")`,
    pruned: [],
    // `unused` survives on its own effect; `helper` survives BECAUSE `unused`
    // (kept) still calls it — see the dedicated soundness row below.
    keptForEffect: ["helper", "unused"],
    sort: true,
  },
  {
    name: "SOUNDNESS: an otherwise-dead-and-PURE define referenced ONLY by a dead-but-effectful sibling survives too — pruning it would dangle the sibling's own reference",
    src: `(define (helper x) (string-append "wrap:" (car (list x))))
(define unused (helper (infer "buried" "deep")))
"root"`,
    pruned: [], // neither survives on ROOT-reachability (there is none)…
    // …but BOTH survive: `unused` on its own effect, `helper` because `unused` (kept) still calls it.
    keptForEffect: ["helper", "unused"],
    sort: true,
    identity: true, // identity fast path — nothing was actually removed
  },
  {
    name: "conservative bucket: a dead define whose only call is FAN-provenance (map) is kept, not pruned",
    src: `(define xs (list 1 2 3))
(define unused (map car xs))
(car xs)`,
    pruned: [],
    keptForEffect: ["unused"],
  },
  {
    name: "mutual recursion: two dead pure defines referencing only each other are BOTH pruned",
    src: `(define (ping n) (if (car n) (pong n) n))
(define (pong n) (ping n))
"alive"`,
    pruned: ["ping", "pong"],
    sort: true,
  },
  {
    name: "mutual recursion reachable from a root: BOTH survive",
    src: `(define (ping n) (if (car n) (pong n) n))
(define (pong n) (ping n))
(ping (list #t))`,
    pruned: [],
  },
  {
    name: "a non-define root (a bare expression) is never a pruning candidate",
    src: `(string-append "a" "b")`,
    pruned: [],
    identity: true,
  },
  {
    name: "requires are never pruned this wave, even when unreferenced (conservative, documented no-op)",
    src: `(require "some-module")
(string-append "a" "b")`,
    pruned: [],
    identity: true,
  },
  {
    name: "redefinition (a name defined more than once) is never pruned — declines entirely, matching propagateTopLevelDefines",
    src: `(define x (string-append "a" "b"))
(define x (string-append "c" "d"))
(car (list x))`,
    pruned: [],
  },
  {
    // The audit's incomplete-closure sibling (E4b class): the fixpoint used to
    // scan only the LAST definition's body, so `helper` — needed solely by the
    // FIRST `g`, which is nonetheless KEPT (redefined names never prune) — was
    // pruned out from under kept code.
    name: "a helper referenced ONLY from an earlier definition of a redefined name survives — every kept body's deps are live",
    src: `(define helper (string-append "h" "i"))
(define g (lambda () helper))
(define g (lambda () "z"))
(car (list (g)))`,
    pruned: [],
  },
  {
    name: "identity fast path: nothing to prune returns the SAME forms array",
    src: `(define used (string-append "a" "b"))
(car (list used))`,
    identity: true,
  },
  {
    name: "no defines at all: identity, no crash",
    src: `(string-append "a" "b")`,
    registry: EMPTY,
    pruned: [],
    keptForEffect: [],
    identity: true,
  },
  {
    name: "an unresolved (non-registry) symbol name is treated as pure — Law F's safe default, matching NO_OWN_CROSSING's `undefined` case",
    src: `(define unused (totally-unregistered-symbol "x"))
"done"`,
    registry: EMPTY,
    pruned: ["unused"],
  },
];

describe("shakeTopLevel — the pure decision", () => {
  for (const row of SHAKE_CASES) {
    it(row.name, () => {
      const { forms } = cf(row.src);
      const decision = shakeTopLevel(forms, row.registry ?? PROVENANCE_REGISTRY);
      if (row.pruned !== undefined) {
        const actual = decision.pruned.map((e) => e.name);
        expect(row.sort === true ? actual.sort() : actual).toEqual(row.pruned);
      }
      if (row.keptForEffect !== undefined) {
        const actual = decision.keptForEffect.map((e) => e.name);
        expect(row.sort === true ? actual.sort() : actual).toEqual(row.keptForEffect);
      }
      if (row.identity === true) expect(decision.forms).toBe(forms);
      if (row.formsLength !== undefined) expect(decision.forms).toHaveLength(row.formsLength);
      if (row.prunedAbsentFromForms === true) {
        for (const name of row.pruned ?? []) {
          expect(decision.forms.some((f) => "name" in f && f.name === name)).toBe(false);
        }
      }
    });
  }
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

// (The real-harness describe lived here; it depended on the oracle package and
// was removed to keep this a pure compiler unit test — the pure-decision
// protocol table and walker-consumption goldens above already prove pruning of
// dead pure defines and survival of dead effectful ones.)
