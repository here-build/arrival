/**
 * LAW F2 — provenance conservation (P10) + mint-at-edge (P11).
 *
 * The second interpreter's conservation law, stated once, property-based:
 * no derivation drops lineage; only declared doors shed; only edges mint.
 *
 * BODIES FILLED (docs/test-suite-v2/DESIGN.md §F2). Mechanism REUSED from the v1
 * suite, not reinvented: `sStr`/`sNum`/`run`/`runRaw` (`./_lineage-test-helpers.js`,
 * the same helpers golden-prov-arithmetic/golden-prov-infer import), `provOf`
 * (`../values/lineage-shadow.js`, the canonical flat/eager stamp reader), and
 * `collapseProvenance` (`../provenance-collapse.js`, the DEEP structural walk —
 * see collapse-provenance.test.ts). The rosetta-mint fixtures mirror
 * `capability-rosetta-symbol.test.ts`'s `wireRosetta`/`invoke`/`invocationWithId`
 * pattern (a synthetic ctx.currentInvocation, no live model needed).
 *
 * FLAT vs DEEP — why the property below asserts DEEP, not flat: `provOf` reads
 * only a value's OWN `.provenance` Set (the container-level stamp); a
 * container-rebuilding op can in principle leave that OWN stamp empty while the
 * ELEMENTS underneath stay individually boxed and stamped. Conservation (P10) is
 * a claim about the VALUE DATAFLOW, not about which object happens to carry the
 * top-level Set, so the property below deep-collapses. The known-violation rows
 * further below are DIFFERENT: they assert the FLAT/element-box convention
 * several sibling ops already honor (`cons` unions onto the container;
 * `vector-filter`/`pair-map` preserve element boxes). append/cdr/vector-map were
 * genuine outliers from that convention — FIXED by the conservation repair (now
 * plain `it`, not `it.fails`: append's rebuilt head and cdr's projected sub-spine
 * are stamped with the deep-collapsed union of their elements, and AVector's map
 * is box-preserving). A13 was the last outlier [GATE: G2] — CLOSED by the C1/C2/C4
 * batch (docs/test-suite-v2/RULINGS.md R2, docs/REWORK-DAG.md): `length` now reads
 * the container's own flat grouping/length-fact stamp (never a deep element union),
 * and every container-rebuilding op threads that stamp explicitly per one of three
 * named verbs — PROXIED / PROVENANCED / MINTED (§3's container-box rows, below, and
 * `_tables/terms.ts`'s `containerBox` column).
 */
import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { APair } from "../../values/primitives/APair.js";
import { AVector } from "../../values/primitives/AVector.js";
import { AString } from "../../values/primitives/AString.js";
import { AValue } from "../../values/primitives/AValue.js";
import { CONSTANT_CTX, type RunContext } from "../../values/primitives/RunContext.js";
import { provOf } from "../../values/lineage-shadow.js";
import { collapseProvenance } from "../../provenance-collapse.js";
import { schemeToJs, type InvocationLike } from "../../rosetta.js";
import { EnvCapability } from "../../common/capability.js";
import { symbol, type RosettaSymbolDef } from "../../common/symbol.js";
import * as z from "../../common/scheme-zod.js";
import type { SchemeEnv } from "../../common/scheme-env.js";
import { ARosettaProcedure } from "../../values/primitives/ACallable.js";
import { withDynamicCallSite } from "../../eval/dynamic-call-site.js";
import { nil } from "../../values/primitives/ANil.js";
import { tf } from "../../values/tagless-final.js";
import type { SchemeValue } from "../../values/types.js";
import { run, runRaw, sNum, sStr } from "../_lineage-test-helpers.js";
import { requireEagerOracle } from "../_require-eager-oracle.js";

// Q20b: the container-box rows below call carrier methods (map/sort/filter)
// directly, not through runRaw/_lineage-test-helpers.js's own save/restore — force
// the oracle ON for this file's lifetime.
requireEagerOracle();

// ═══════════════════════════════════════════════════════════════════════════
// PROPERTY GENERATOR — small typed Scheme-program grammar (§1 of the task).
//
// Draws from EXACTLY the grammar the law specifies: `+ * string-append cons
// list car if let`. `cdr` is deliberately EXCLUDED — `(cdr (list …))` is one of
// the four known-violation rows below, and folding it into the generic property
// would make the property spuriously red for a reason unrelated to what it
// tests. `if`'s condition is ALWAYS a literal `#t`/`#f` chosen at GENERATION
// time (never a computed/source-dependent predicate) — this is what makes
// reachability STATICALLY known: which arm is "taken" is decided before the
// program text is even rendered, so the expected-reachable id set can be
// computed by construction instead of re-deriving it from the eager engine
// (which would make the property circular). `let` is pure substitution — a
// bound name occurring in the body carries exactly the binding's ids, an
// unused binding contributes nothing (matches the observed golden in
// golden-prov-special-forms.test.ts: "a let body that returns a pure literal
// carries NOTHING").
//
// Types are threaded so every generated program TYPECHECKS at the Scheme
// level (no `(+ "x" 1)` nonsense that would throw before provenance is even
// observable): a small scalar type (num | str) plus a PAIR type restricted to
// carrying SCALARS only (no list-of-list / cons-of-cons) — this bounds
// recursion structurally (a pair's children are always scalar-resolvable at
// any depth via the literal leaf), so the depth cap can never strand the
// generator in a type with no base case.
// ═══════════════════════════════════════════════════════════════════════════

type ScalarTy = { readonly kind: "num" } | { readonly kind: "str" };
type PairTy =
  | { readonly kind: "listOf"; readonly elem: ScalarTy }
  | { readonly kind: "consOf"; readonly car: ScalarTy; readonly cdr: ScalarTy };
type Ty = ScalarTy | PairTy;

const NUM: ScalarTy = { kind: "num" };
const STR: ScalarTy = { kind: "str" };

const tyEq = (a: ScalarTy, b: ScalarTy): boolean => a.kind === b.kind;

interface Source {
  readonly name: string;
  readonly ty: ScalarTy;
  readonly id: number;
}
interface Ref {
  readonly name: string;
  readonly ty: ScalarTy;
  readonly ids: readonly number[];
}
interface GenCtx {
  readonly sources: readonly Source[];
  readonly refs: readonly Ref[];
}
interface Gen {
  readonly code: string;
  readonly ids: readonly number[]; // full deep-reachable ids for this subexpression's VALUE
  readonly headIds: readonly number[]; // ids a `car` projection of this value would carry (pair producers only)
  readonly ty: Ty;
}

// Deterministic PRNG (mulberry32) seeded by an integer fast-check supplies — this IS
// "using fast-check": `fc.assert`/`fc.asyncProperty` drives the seed, owns reproduction
// (a failing run prints the seed) and shrinks toward 0, while the seed derives the WHOLE
// random program deterministically so the same seed always renders the same source text.
interface Rng {
  readonly float: () => number;
  readonly int: (min: number, max: number) => number;
  readonly bool: (pTrue: number) => boolean;
  readonly pick: <T>(arr: readonly T[]) => T;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeRng(seed: number): Rng {
  const rand = mulberry32(seed);
  return {
    float: () => rand(),
    int: (min, max) => min + Math.floor(rand() * (max - min + 1)),
    bool: (pTrue) => rand() < pTrue,
    pick: <T>(arr: readonly T[]): T => arr[Math.floor(rand() * arr.length)] as T,
  };
}

function shuffle<T>(rng: Rng, arr: readonly T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng.float() * (i + 1));
    const tmp = a[i] as T;
    a[i] = a[j] as T;
    a[j] = tmp;
  }
  return a;
}

const union = (...arrs: readonly (readonly number[])[]): number[] => [...new Set(arrs.flat())];

let letCounter = 0;

type CompoundKind = "add" | "mul" | "strApp" | "car" | "let" | "if";

function genScalar(rng: Rng, ctx: GenCtx, ty: ScalarTy, depth: number): Gen {
  const leaves: Array<() => Gen> = [];
  if (ty.kind === "num") leaves.push(() => ({ code: String(rng.int(-20, 20)), ids: [], headIds: [], ty }));
  else leaves.push(() => ({ code: JSON.stringify(`lit${rng.int(0, 999)}`), ids: [], headIds: [], ty }));
  for (const s of ctx.sources) {
    if (tyEq(s.ty, ty)) leaves.push(() => ({ code: s.name, ids: [s.id], headIds: [s.id], ty }));
  }
  for (const r of ctx.refs) {
    if (tyEq(r.ty, ty)) leaves.push(() => ({ code: r.name, ids: [...r.ids], headIds: [...r.ids], ty }));
  }

  if (depth <= 0 || rng.bool(0.35)) return rng.pick(leaves)();

  const options: readonly CompoundKind[] =
    ty.kind === "num" ? (["add", "mul", "car", "let", "if"] as const) : (["strApp", "car", "let", "if"] as const);
  const kind = rng.pick(options);

  if (kind === "add" || kind === "mul") {
    const a = genScalar(rng, ctx, ty, depth - 1);
    const b = genScalar(rng, ctx, ty, depth - 1);
    const op = kind === "add" ? "+" : "*";
    return { code: `(${op} ${a.code} ${b.code})`, ids: union(a.ids, b.ids), headIds: [], ty };
  }
  if (kind === "strApp") {
    const a = genScalar(rng, ctx, ty, depth - 1);
    const b = genScalar(rng, ctx, ty, depth - 1);
    return { code: `(string-append ${a.code} ${b.code})`, ids: union(a.ids, b.ids), headIds: [], ty };
  }
  if (kind === "car") {
    const otherTy: ScalarTy = rng.bool(0.5) ? NUM : STR;
    const container: PairTy = rng.bool(0.5) ? { kind: "listOf", elem: ty } : { kind: "consOf", car: ty, cdr: otherTy };
    const g = genPair(rng, ctx, container, depth - 1);
    // car projects the HEAD element only — the sibling's ids do not flow (§5.3 element
    // projection; golden-prov-arithmetic "(car (cons a b)) — car projects the head element").
    return { code: `(car ${g.code})`, ids: [...g.headIds], headIds: [], ty };
  }
  if (kind === "let") {
    const valTy: ScalarTy = rng.bool(0.5) ? NUM : STR;
    const val = genScalar(rng, ctx, valTy, depth - 1);
    const name = `lv${letCounter++}`;
    const nextCtx: GenCtx = { sources: ctx.sources, refs: [...ctx.refs, { name, ty: valTy, ids: val.ids }] };
    const body = genScalar(rng, nextCtx, ty, depth - 1);
    // let is pure substitution: the body's ids already account for every occurrence
    // (0, 1, or N) of `name` via the leaf lookup above — no extra union needed here.
    return { code: `(let ((${name} ${val.code})) ${body.code})`, ids: [...body.ids], headIds: [], ty };
  }
  // if — condition is ALWAYS a literal, decided here at generation time, so the taken
  // arm is statically known; the untaken arm's ids never flow (the caution the task
  // names explicitly: an if's untaken arm legitimately doesn't reach the output).
  const takeThen = rng.bool(0.5);
  const thenN = genScalar(rng, ctx, ty, depth - 1);
  const elseN = genScalar(rng, ctx, ty, depth - 1);
  const taken = takeThen ? thenN : elseN;
  return { code: `(if ${takeThen ? "#t" : "#f"} ${thenN.code} ${elseN.code})`, ids: [...taken.ids], headIds: [], ty };
}

function genPair(rng: Rng, ctx: GenCtx, ty: PairTy, depth: number): Gen {
  if (ty.kind === "listOf") {
    const n = rng.int(2, 3);
    const items: Gen[] = [];
    for (let i = 0; i < n; i++) items.push(genScalar(rng, ctx, ty.elem, depth - 1));
    return {
      code: `(list ${items.map((i) => i.code).join(" ")})`,
      ids: union(...items.map((i) => i.ids)),
      headIds: [...(items[0]?.ids ?? [])],
      ty,
    };
  }
  const a = genScalar(rng, ctx, ty.car, depth - 1);
  const b = genScalar(rng, ctx, ty.cdr, depth - 1);
  return { code: `(cons ${a.code} ${b.code})`, ids: union(a.ids, b.ids), headIds: [...a.ids], ty };
}

function genExpr(rng: Rng, ctx: GenCtx, ty: Ty, depth: number): Gen {
  return ty.kind === "listOf" || ty.kind === "consOf" ? genPair(rng, ctx, ty, depth) : genScalar(rng, ctx, ty, depth);
}

function pickRootTy(rng: Rng): Ty {
  const options: readonly Ty[] = [
    NUM,
    STR,
    { kind: "listOf", elem: NUM },
    { kind: "listOf", elem: STR },
    { kind: "consOf", car: NUM, cdr: STR },
    { kind: "consOf", car: STR, cdr: NUM },
  ];
  return rng.pick(options);
}

const INITIAL_DEPTH = 3;

/** Render one random program (over 2–4 stamped sources drawn from a fixed 4-slot pool)
 *  and return its source text, the expected-reachable id set, and its env bindings. */
function buildProgram(seed: number): { code: string; ids: number[]; binds: Record<string, unknown> } {
  const rng = makeRng(seed);
  letCounter = 0;
  const pool: Source[] = [
    { name: "n1", ty: NUM, id: 11 },
    { name: "n2", ty: NUM, id: 12 },
    { name: "s1", ty: STR, id: 13 },
    { name: "s2", ty: STR, id: 14 },
  ];
  const k = rng.int(2, 4);
  const chosen = shuffle(rng, pool).slice(0, k);
  const ctx: GenCtx = { sources: chosen, refs: [] };
  const program = genExpr(rng, ctx, pickRootTy(rng), INITIAL_DEPTH);
  const binds: Record<string, unknown> = {};
  for (const s of pool) binds[s.name] = s.ty.kind === "num" ? sNum(s.id, s.id) : sStr(`src${s.id}`, s.id);
  return { code: program.code, ids: [...new Set(program.ids)], binds };
}

// ═══════════════════════════════════════════════════════════════════════════
// ROSETTA-MINT FIXTURE — mirrors capability-rosetta-symbol.test.ts's
// wireRosetta/invoke/invocationWithId pattern (a synthetic ctx.currentInvocation
// drives the REAL `EnvCapability.lower()` rosetta arm, no live model needed).
// ═══════════════════════════════════════════════════════════════════════════

// Post-binder-cut (capability.ts rosetta case → ARosettaProcedure, §9 option (c)) the
// wired verb is a callable VALUE, invoked through its apply term with the invocation
// published on the evaluator-owned ambient — this harness mirrors the evaluator's own
// apply-site shape (`withDynamicCallSite` around the term dispatch), not a hand-built
// `this`.
function recordingEnv(): { env: SchemeEnv; verbs: Record<string, ARosettaProcedure> } {
  const verbs: Record<string, ARosettaProcedure> = {};
  const env = {
    set: (name: string, value: unknown) => void (verbs[name] = value as ARosettaProcedure),
    get: () => undefined,
    inherit: () => env,
    registerResolver: () => undefined,
    list: () => [],
    allBoundNames: () => [],
  } as unknown as SchemeEnv;
  return { env, verbs };
}

async function wireRosetta(def: RosettaSymbolDef): Promise<ARosettaProcedure> {
  const cap = new EnvCapability("test/conservation-rosetta", { symbols: { verb: def } });
  const { env, verbs } = recordingEnv();
  await cap.lower({}).apply(env, undefined as never);
  expect(verbs.verb).toBeInstanceOf(ARosettaProcedure); // the binder-cut bind shape itself
  return verbs.verb;
}

function invocationWithId(id: number): { invocation: InvocationLike; marked: () => boolean } {
  let didMark = false;
  const invocation: InvocationLike = {
    id,
    isProvenancePoint: false,
    markProvenancePoint() {
      didMark = true;
      this.isProvenancePoint = true;
    },
  };
  return { invocation, marked: () => didMark };
}

function invoke(
  verb: ARosettaProcedure,
  opts: { runCtx?: RunContext; currentInvocation?: InvocationLike } | undefined,
  ...args: unknown[]
): unknown {
  // The evaluator's apply-site shape: publish the invocation on the ambient leaf, then
  // dispatch the apply term with runCtx only — the binder adapter reads the ambient back
  // into the wrapper's CallCtx (§9 option (c)).
  return withDynamicCallSite(opts?.currentInvocation, () =>
    verb[tf("apply")](args as SchemeValue[], opts?.runCtx ?? CONSTANT_CTX),
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// §1 — THE CONSERVATION PROPERTY
// ═══════════════════════════════════════════════════════════════════════════

describe("conservation — every input id survives to the output or the trace", () => {
  it("property: for generated pure programs over 2–4 stamped sources, deep-collapsed output provenance ⊇ every reachable input id", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 2 ** 31 - 1 }), async (seed) => {
        const { code, ids, binds } = buildProgram(seed);
        const result = await runRaw(code, binds);
        const deep = collapseProvenance(result);
        for (const id of ids) {
          expect(deep.has(id), `program ${code}\nexpected reachable id ${id}; deep-collapsed = ${[...deep].sort((a, b) => a - b).join(",")}`).toBe(true);
        }
      }),
      { numRuns: 50 },
    );
  });

  // §2 — THE KNOWN-VIOLATION ROWS (manifest B). Each cites its ledger row
  // (src/__tests__/ledger/index.law.test.ts) and asserts the CORRECT/target
  // behavior. append/cdr/DR4 were FIXED by the conservation repair (flipped from
  // `it.fails` to plain `it` — GAPS rows retired); A13 flipped GREEN at c27b2e8b62
  // (C1/C2/C4 — length reads container facts). G2 gate CLOSED; ledger row retired.
  describe("known violations — real gaps, ledgered, flip on the conservation repair", () => {
    it(
      "(append (list a) (list b)) — the rebuilt spine's OWN (flat) provenance is the union of both elements, matching cons' union-onto-container convention",
      async () => {
        // FIXED (conservation repair): the rebuilt spine's head cell is now stamped with the
        // deep-collapsed union of both operands' elements (P10), matching the FLAT convention
        // `cons` already honors ("(cons a b) — the cons cell carries the UNION of both
        // elements") instead of relying on a deep walk downstream.
        const r = await runRaw(`(append (list a) (list b))`, { a: sStr("a", 100), b: sStr("b", 200) });
        expect(provOf(r)).toEqual([100, 200]);
      },
    );

    it(
      "(cdr (list a b)) — the tail spine's OWN (flat) provenance carries b's id, not empty",
      async () => {
        // FIXED (conservation repair): the projected tail sub-spine is now stamped with the
        // deep-collapsed union of what it still reaches (P10) — cdr of a proper list carries
        // its sub-spine's element ids at the FLAT level, matching cdr-of-cons' element
        // projection instead of dropping to empty.
        const r = await runRaw(`(cdr (list a b))`, { a: sStr("a", 100), b: sStr("b", 200) });
        expect(provOf(r)).toEqual([200]);
      },
    );

    // FIXED (C4 interim fix, docs/test-suite-v2/RULINGS.md R2 + execution-plan-wireframe.md
    // §7, batch C1/C2/C4 per docs/REWORK-DAG.md). Was `@ledger: A13 count-cone
    // over-attribution`, `it.fails`.
    it(
      "(length (map id xs)) — the count's cone is the MINIMAL grouping fact (no per-element ids), not every element id [GATE: G2 — CLOSED]",
      async () => {
        // FIXED: `length` (values/primitives/{APair,AVector,AJSArray}.ts) now reads the
        // CONTAINER's own flat grouping/length-fact stamp instead of deep-unioning every
        // element it touched — a pure-map length depends only on the collection's
        // CARDINALITY (the grouping fact), not on what each element became. `map` is
        // length-PRESERVING, so it PROXIES the container's own stamp through unchanged
        // (op-helpers.ts's `withInputProvenance`). This fixture mints no container-level
        // "grouping" id at all (a plain `APair.fromArray` list, no Rosetta-IN crossing for
        // the list itself), so the correct cone here is EMPTY — asserting the absence of
        // the leak, matching golden-prov-fan.test.ts's now-green sibling row.
        const xs = APair.fromArray(CONSTANT_CTX, [sStr("a", 100), sStr("b", 101), sStr("c", 102)], false);
        const r = await runRaw(`(length (map (lambda (e) e) xs))`, { xs });
        expect(provOf(r)).toEqual([]);
      },
    );

    it(
      "vector-map — mapped elements keep their ORIGINAL boxes, not fresh empty-provenance re-boxes (DR4)",
      async () => {
        // FIXED (DR4): `(map id (vector a b))` used to cross out to the auto-wrapping
        // AJSArray, re-boxing elements from the RAW (unprovenanced) source on access —
        // `elemProvs` came back `[[], []]`. AVector's map is now box-preserving (mirrors
        // pair-map and vector-filter — P8's "one algebra, every carrier"), rebuilding a
        // fresh AVector holding the SAME element boxes.
        const r = await runRaw(`(map (lambda (e) e) (vector a b))`, { a: sStr("a", 100), b: sStr("b", 200) });
        const vec = (r as { __vector__?: unknown[] }).__vector__ ?? [];
        expect(vec.map((e) => provOf(e))).toEqual([[100], [200]]);
      },
    );
  });

  // §3 — CONTAINER-BOX ROWS (R2 ruling, RULINGS.md; C1's law table, _tables/terms.ts's
  // `containerBox` column). The three named verbs:
  //   PROXIED     — length-preserving ops (map, sort) thread the container's own
  //                 grouping/length-fact stamp through unchanged.
  //   PROVENANCED — length-changing ops (filter) mint a FRESH derived stamp = union(the
  //                 input container's own stamp, the decision lineage that changed the
  //                 length — here, the surviving elements' own top-level provenance).
  //   MINTED      — constructors (cons/list/vector) union their ARGS' own provenance onto
  //                 the freshly built head (env/r7rs/lists.ts's `list`/`cons`,
  //                 env/r7rs/vectors.ts's `vector` — already covered by those files' own
  //                 tests, not re-asserted here).
  // P8 ("one algebra, every carrier") requires ONE answer across carriers — the paired
  // Pair/Vector assertions below check AGREEMENT directly. This closes the divergence
  // VERDICTS.md/coercion-soundness.test.ts used to flag ("Pair-sort drops the container
  // box while Vector-sort preserves it"): both now PROXY identically.
  describe("container-box rows — PROXIED (map/sort) / PROVENANCED (filter), Pair and Vector agree (P8)", () => {
    const STAMP = new Set([7]);
    const mkStampedPair = () =>
      new APair(CONSTANT_CTX, sStr("a", 100), new APair(CONSTANT_CTX, sStr("b", 101), nil)).withProvenance(STAMP);
    const mkStampedVector = () => new AVector(CONSTANT_CTX, [sStr("a", 100), sStr("b", 101)], STAMP);
    const idFn = (x: SchemeValue): SchemeValue => x;
    const keepAll = () => true;
    const dropB = (x: unknown) => (x as AString).valueOf() !== "b";

    it("map PROXIES the container's own stamp through — Pair and Vector agree", async () => {
      const pairOut = await Promise.resolve(mkStampedPair()[tf("map")](idFn));
      const vecOut = await Promise.resolve(mkStampedVector()[tf("map")](idFn));
      expect(provOf(pairOut)).toEqual([7]);
      expect(provOf(vecOut)).toEqual([7]);
    });

    it("sort PROXIES the container's own stamp through — Pair and Vector agree (the old divergence is closed)", async () => {
      const cmp = (a: unknown, b: unknown) => String((a as AString).valueOf()).localeCompare(String((b as AString).valueOf()));
      const pairOut = mkStampedPair()[tf("sort")](cmp);
      const vecOut = mkStampedVector()[tf("sort")](cmp);
      expect(provOf(pairOut)).toEqual([7]);
      expect(provOf(vecOut)).toEqual([7]);
    });

    it("filter (keep-all) PROVENANCES union(container's own stamp, survivors) — Pair and Vector agree", async () => {
      const pairOut = await Promise.resolve(mkStampedPair()[tf("filter")](keepAll));
      const vecOut = await Promise.resolve(mkStampedVector()[tf("filter")](keepAll));
      expect(provOf(pairOut)).toEqual([7, 100, 101]);
      expect(provOf(vecOut)).toEqual([7, 100, 101]);
    });

    it("filter (drop one) PROVENANCES union(container's own stamp, SURVIVING elements only) — Pair and Vector agree", async () => {
      const pairOut = await Promise.resolve(mkStampedPair()[tf("filter")](dropB));
      const vecOut = await Promise.resolve(mkStampedVector()[tf("filter")](dropB));
      expect(provOf(pairOut)).toEqual([7, 100]); // 101 (the dropped "b") never flows
      expect(provOf(vecOut)).toEqual([7, 100]);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §4 — MINT-AT-EDGE (P11): ids appear only at declared crossings.
// ═══════════════════════════════════════════════════════════════════════════

describe("mint-at-edge — ids appear only at declared crossings", () => {
  it("property: interior pure ops over literals produce EMPTY provenance (no interior minting)", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: -100, max: 100 }),
        fc.integer({ min: -100, max: 100 }),
        async (a, b, c) => {
          expect(await run(`(+ ${a} (* ${b} ${c}))`)).toEqual([]);
        },
      ),
      { numRuns: 20 },
    );
  });

  it("property: one source consumed N times still carries exactly that source (pipe, not fan-in)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 0, max: 10_000 }), async (n, id) => {
        expect(await run(`(+ x (+ x (* x x)))`, { x: sNum(n, id) })).toEqual([id]);
      }),
      { numRuns: 20 },
    );
  });

  it("a `pure: true` rosetta NEVER mints, even under a live invocation ctx (the seal-laundering guard)", async () => {
    // Mirrors capability-rosetta-symbol.test.ts's "pure: true FORWARDS input provenance
    // even WITH a ctx invocation" — restated here as the F2 mint-at-edge law's own row.
    const def = symbol.rosetta`echo: identity string`(
      { input: [z.string], output: [z.string], provenance: "pipe" },
      (s: string) => s,
    );
    const verb = await wireRosetta(def);
    const { invocation, marked } = invocationWithId(42);
    const tagged = new AString(CONSTANT_CTX, "x", new Set([99]));
    const out = (await invoke(verb, { currentInvocation: invocation }, tagged)) as AString;
    expect([...out.provenance]).toEqual([99]); // FORWARDED (pure), not minted(42)
    expect(marked()).toBe(false); // a pure rosetta never marks the invocation a point
  });

  it("a source rosetta mints EXACTLY ONE fresh point per crossing, independent of arguments (two calls → two distinct ids)", async () => {
    const def = symbol.rosetta`strlen: length of a string`(
      { input: [z.string], output: [z.number] },
      (s: string) => s.length,
    );
    const verb = await wireRosetta(def);
    const call1 = invocationWithId(101);
    const call2 = invocationWithId(202);
    // SAME argument both times — only the invocation's own id should differ.
    const out1 = (await invoke(verb, { currentInvocation: call1.invocation }, new AString(CONSTANT_CTX, "hello"))) as AValue;
    const out2 = (await invoke(verb, { currentInvocation: call2.invocation }, new AString(CONSTANT_CTX, "hello"))) as AValue;
    expect([...out1.provenance]).toEqual([101]);
    expect([...out2.provenance]).toEqual([202]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// §5 — NAMED SHEDS: the only legal losses (P10's two named doors).
// ═══════════════════════════════════════════════════════════════════════════

describe("named sheds — the only legal losses", () => {
  it("(exact->inexact x) — MEASURED: propagates provenance fully today (no drop)", async () => {
    // P10 names `exact->inexact` as "the explicit lossiness door" — but the lossiness it
    // documents is the VALUE-layer one (exactness, a numeric-representation fact), not
    // this Set: measured behavior is that the source's provenance rides straight through
    // the conversion, same as any other pure unary op (`(abs a)` in golden-prov-arithmetic).
    // No drop observed here, so nothing to name as a shed on the PROVENANCE layer.
    const r = await runRaw(`(exact->inexact x)`, { x: sNum(3, 900) });
    expect(provOf(r)).toEqual([900]);
    expect(r instanceof AValue ? r["arrival/toJS"]() : r).toBe(3);
  });

  it("egress: schemeToJs leaves lineage in the trace keyed by scope; the returned JS value carries no provenance property", async () => {
    const raw = await runRaw(`a`, { a: sStr("a", 100) });
    expect(provOf(raw)).toEqual([100]); // pre-egress: the boxed value IS stamped
    const egressed: unknown = schemeToJs(raw);
    expect(egressed).toBe("a");
    // The trace keeps the lineage keyed by scope (P4/P12); the crossed-over JS value
    // itself carries no `provenance` property at all — not an empty one, ABSENT.
    expect(Object.prototype.hasOwnProperty.call(Object(egressed), "provenance")).toBe(false);
  });
});
