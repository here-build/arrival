/**
 * LAW (staged) — V1/V2/V4 role-vocabulary rows (docs/PROVENANCE.md §2 "Declaration
 * vocabulary"; docs/PROVENANCE-PLAN.md Cluster V, Q5's stub-file mapping table).
 *
 * Q5 CREATES this file as pure `it.todo` staged spec — none of V1/V2/V4's machinery
 * exists yet. Every row below flips at the Q-node named in its `// @ledger:` comment;
 * Q2 lands the declared `provenance` role field CONCURRENTLY with this file landing,
 * so these rows are written against the SPEC's shape (docs/PROVENANCE.md §2), not
 * against any Q2-in-flight code — they go live in Q2/Q3's wake, never edited to match
 * an interim shape.
 *
 * V3 (opaque quarantine drift alarm) is DELIBERATELY NOT duplicated here — its counted-
 * walk machinery already landed at Q1 and lives in the sibling
 * `laws/opaque-quarantine.law.test.ts` (`countOpaqueNodes`, `src/values/lineage.ts`),
 * whose own header explicitly reserves the option of Q5 folding it in rather than
 * duplicating it. This file takes the "don't duplicate" branch; V3's staged baseline
 * row (`@ledger: opaque quarantine baseline pinned pre-Q6`) stays exactly where it is.
 *
 * V1 (Q2) — the declared `provenance` role field + its drift-alarm door.
 * V2 (Q3) — the classifier consumes declared roles ONLY (heuristics deleted).
 * V2-Q4 (Q4) — callback roles extracted from the contract (z.lambda position + return
 *   shape), declaration override where shape underdetermines, the drift-door extension,
 *   and the fold acc-chain marker.
 * V4 (Q8a′) — cone-traversal termination over cyclic `binder{cycles}` (loop) nodes.
 * Q7 (Q7) — program-prelude PURE-only membership: the REJECTED half of the plan's
 *   "BOTH directions" gate (a fetch-wrapping helper, direct AND transitive, refused
 *   membership with a teaching door). The positive half (a pure helper referenced by
 *   name stays prelude-side, resolved through the sealed chain) lives in the sibling
 *   `provenance/wireframe-agreement.law.test.ts` (closer to that file's assembler/
 *   chain-resolution concerns).
 */
import { describe, it, expect } from "vitest";
import { initBridge } from "../../index.js";
import { parse } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../inference-env.js";
import { classify, type Classifier } from "../../values/lineage.js";
import { classifierFromEnv } from "../../values/lineage-classifier-from-env.js";
import * as z from "../../common/scheme-zod.js";
import { declaresAccChain, symbol, withCallbackRoles, type AEntity, type CallbackRoles } from "../../common/symbol.js";
import { EnvCapability } from "../../common/capability.js";
import { ProvenanceRoleShapeError, PreludeMembershipError } from "../../errors.js";
import { classifyProgramPrelude, assertPreludeEligible } from "../../provenance/prelude.js";
import { freshEnv } from "../_fresh-env.js";
import { theVoid } from "../../values/primitives/AVoid.js";
import srfi1 from "../../env/srfi/srfi-1.js";
import srfi95 from "../../env/srfi/srfi-95.js";
import lists from "../../env/r7rs/lists.js";
import strings from "../../env/r7rs/strings.js";
import vectors from "../../env/r7rs/vectors.js";
import binding from "../../env/r7rs/binding.js";
import equality from "../../env/r7rs/equality.js";

/** Resolved callback roles off a pack's REAL exported def (the data plane Q3/Q8a read) —
 *  same `.spec.symbols` access idiom as the `*-contract-precision.test.ts` files. */
function rolesOf(pack: { spec: { symbols?: unknown } }, name: string): CallbackRoles | undefined {
  const d = (pack.spec.symbols as Record<string, AEntity>)[name];
  if (d === undefined) throw new Error(`pack has no symbol named ${name}`);
  return "callbackRoles" in d ? d.callbackRoles : undefined;
}

describe("V1 — declared provenance role (§2 CHOSEN: one role per symbol declaration)", () => {
  // @ledger: Q2
  it.todo(
    "every symbol declaration carries exactly one `provenance` role from " +
      "{pipe, fan, source, sink, transparent, loop, opaque} — pipe default for " +
      "native/sequence/tagless kinds, source default for rosetta",
  );

  // @ledger: Q2
  it.todo(
    "the two ad-hoc booleans `fanout?`/`pure?` are GONE, not merely deprecated — " +
      "no declaration surface accepts them any more (§2 EXCLUDED: \"degenerate two-word " +
      "fragment of this vocabulary; each had exactly two readers\")",
  );

  // @ledger: Q2
  it.todo(
    "declaration-completeness: every bound symbol that reaches the classifier has a " +
      "declared role — an undeclared symbol is a build-time error, never a silent " +
      "default-to-opaque",
  );

  // @ledger: Q2
  it.todo(
    "drift-alarm door (assembly-time): a declared role inconsistent with its contract " +
      "shape (e.g. declared `pipe` but the z.lambda position/return shape implies `fan`) " +
      "trips the door at assembly time — CONTRADICTIONS only, never silent (§2 LIMIT: " +
      "\"catches CONTRADICTIONS, not lies: a JS body that fans while declared pipe is " +
      "consistent-but-wrong; contract shape cannot see JS bodies\")",
  );

  // @ledger: Q2
  it.todo(
    "declaration kinds LOWER 1:1 to graph node kinds (one vocabulary, two layers): " +
      "`loop` → `binder{cycles}`; `sink`/`transparent` are declaration-layer facts " +
      "lowering to graph shapes, never a second parallel vocabulary (§2 EXCLUDED, panel C11)",
  );
});

describe("V2 — declaration-driven classifier (§2; PROVENANCE-PLAN.md Q3)", () => {
  // @ledger: Q3 — LANDED
  it(
    "the classifier reads ONLY the declared `provenance` role — the `isRosettaIn` " +
      "heuristic and the `.fanout` duck-read off a bound function are DELETED, not " +
      "merely bypassed (§2 EXCLUDED: \"the key-taxonomy violation the P7 corollary " +
      "exists to kill; every static interpreter reads the declared field\")",
    async () => {
      await initBridge();
      // Names picked to defeat any residual name-based guess — a "pure"-sounding name
      // declared `source`, and a name with no source-y hint declared `pipe`. If
      // classify() still consulted a name list (the retired heuristic) rather than
      // the declared role alone, one of these would misclassify.
      const C: Classifier = {
        roleOf: (op) => (op === "totally-pure-sounding" ? "source" : op === "clearly-a-mint" ? "pipe" : undefined),
      };
      const [mintAst] = await parse(`(totally-pure-sounding p)`, inferenceEnv);
      expect(classify(mintAst, C).kind).toBe("source");
      const [pipeAst] = await parse(`(clearly-a-mint p)`, inferenceEnv);
      expect(classify(pipeAst, C).kind).toBe("pipe");

      // The retired seam, structurally: `classifierFromEnv` used to accept a
      // caller-supplied `sources: ReadonlySet<string>` second parameter (the
      // heuristic this row retires) — it is now arity-1, reading the bound value's
      // declared `.provenanceRole` alone (`values/lineage-classifier-from-env.ts`).
      expect(classifierFromEnv.length).toBe(1);
    },
  );

  // @ledger: Q3 — LANDED
  it(
    "named-let and `do` loops classify as `loop` (lowering to `binder{cycles}`), " +
      "not `opaque` — this is the exact corpus row `laws/opaque-quarantine.law.test.ts` " +
      "used to mark \"opaque today (pending Q3's binder rewrite)\": `(let loop ((a v1)) a)` " +
      "flipped off that corpus's opaque count when this landed",
    async () => {
      await initBridge();
      const C: Classifier = { roleOf: () => undefined };

      const [namedLetAst] = await parse(`(let loop ((a v1)) a)`, inferenceEnv);
      const namedLet = classify(namedLetAst, C);
      expect(namedLet.kind).toBe("binder");
      if (namedLet.kind === "binder") {
        expect(namedLet.cycles).toBe(true);
        expect(namedLet.op).toBe("named-let");
      }

      const [doAst] = await parse(`(do ((i 0 (+ i 1))) ((= i 3) i))`, inferenceEnv);
      const doNode = classify(doAst, C);
      expect(doNode.kind).toBe("binder");
      if (doNode.kind === "binder") {
        expect(doNode.cycles).toBe(true);
        expect(doNode.op).toBe("do");
      }
    },
  );

  // @ledger: Q4 — LANDED (the whole extraction family lives in the V2-Q4 describe below;
  // this row keeps the original Q5 statement as the umbrella assertion)
  it(
    "callback roles are extracted from the contract (z.lambda position + return shape) " +
      "into element-transformer / control / effect / accumulator, with declaration " +
      "override only where the contract underdetermines (§2 CHOSEN)",
    () => {
      // SHAPE-EXTRACTED (no declaration on either def):
      // map/vector-map — fan host + value egress ⇒ element-transformer (the fan default).
      expect(rolesOf(lists, "map")).toEqual(["element-transformer"]);
      expect(rolesOf(vectors, "vector-map")).toEqual(["element-transformer"]);
      // the for-each family — void-family host egress ⇒ effect (shape-DECIDED: the
      // callback's product has no egress wire to ride).
      expect(rolesOf(lists, "for-each")).toEqual(["effect"]);
      expect(rolesOf(strings, "string-for-each")).toEqual(["effect"]);
      expect(rolesOf(vectors, "vector-for-each")).toEqual(["effect"]);

      // DECLARED where shape underdetermines (or merely defaults):
      // filter — shape-identical to map (fan + value egress ⇒ the element-transformer
      // DEFAULT), overridden to `control`: the pred is the length-changing selector
      // (§2 R2's PROVENANCED verb; the merged selector+decision one-color ruling).
      expect(rolesOf(srfi1, "filter")).toEqual(["control"]);
      // find/member/assoc — pipe hosts, value egress: underdetermined ⇒ declared
      // `control` (boolean selectors deciding WHICH element egresses). member/assoc's
      // compare is lambda arm 0 despite sitting at input position 2 — roles align with
      // LAMBDA arms, not input positions.
      expect(rolesOf(srfi1, "find")).toEqual(["control"]);
      expect(rolesOf(lists, "member")).toEqual(["control"]);
      expect(rolesOf(lists, "assoc")).toEqual(["control"]);
      // sort — pipe host, value egress, `z.lambda.optional()` at input position 1:
      // the optional wrapper still counts as a lambda arm, and the ordering comparator
      // is declared `control` (the host-schedule op of spec §5).
      expect(rolesOf(srfi95, "sort")).toEqual(["control"]);
      // string-map — pipe host (never a declared fan), value egress: underdetermined ⇒
      // declared element-transformer (proc's return BECOMES the output character).
      expect(rolesOf(strings, "string-map")).toEqual(["element-transformer"]);

      // UNDERDETERMINED + UNDECLARED = honest holes, never guesses:
      // call-with-values' producer/consumer fit none of the four roles — both arms
      // resolve undefined.
      expect(rolesOf(binding, "call-with-values")).toEqual([undefined, undefined]);
      // procedure? takes a z.lambda it NEVER INVOKES (an introspection subject, not a
      // callback) and returns a boolean — a host-boolean-return rule would door it as a
      // decision callback, which is exactly the guess extraction refuses to make.
      expect(rolesOf(equality, "procedure?")).toEqual([undefined]);

      // No z.lambda arm at all ⇒ no callbackRoles field content (undefined, not []).
      expect(rolesOf(lists, "cons")).toBeUndefined();
    },
  );
});

describe("V2-Q4 — callback-role drift door + acc chain + stamp path (§2/§3; PROVENANCE-PLAN.md Q4)", () => {
  // @ledger: Q4 — LANDED
  it(
    "drift-door extension: a declaration CONTRADICTING decidable shape throws " +
      "ProvenanceRoleShapeError at bake (void-egress arms are DECIDED `effect`; a role " +
      "for a phantom callback is a decidable contradiction) — while overriding a mere " +
      "DEFAULT passes (under-trigger, never guess)",
    () => {
      // Contradicting a DECIDED arm: void-family egress decides `effect`; declaring the
      // arm an element-transformer is a shape-visible lie → door.
      expect(() =>
        symbol.native`q4-bad-effect: declared transformer under void egress`(
          { input: [z.lambda], output: [z.undefinedResult], callbackRoles: ["element-transformer"] },
          () => theVoid,
        ),
      ).toThrow(ProvenanceRoleShapeError);
      // Agreeing with the DECIDED arm passes — declaration may restate shape.
      expect(
        symbol.native`q4-ok-effect: declared effect under void egress`(
          { input: [z.lambda], output: [z.undefinedResult], callbackRoles: ["effect"] },
          () => theVoid,
        ).callbackRoles,
      ).toEqual(["effect"]);
      // Phantom callback: roles declared with NO z.lambda arm to carry them → door.
      expect(() =>
        symbol.native`q4-phantom: roles with no lambda arm`(
          { input: [z.string], output: [z.string], callbackRoles: ["control"] },
          (s) => s,
        ),
      ).toThrow(ProvenanceRoleShapeError);
      // MORE roles than lambda arms → door (same phantom-callback contradiction).
      expect(() =>
        symbol.native`q4-excess: two roles, one lambda arm`(
          { input: [z.lambda, z.value], output: [z.value], callbackRoles: ["control", "control"] },
          (f, v) => v,
        ),
      ).toThrow(ProvenanceRoleShapeError);
      // Overriding the fan DEFAULT (element-transformer) to control does NOT door —
      // filter's exact shape; the default yields to declaration.
      expect(
        symbol.native`q4-fan-override: fan default overridden to control`(
          { input: [z.lambda, z.value], output: [z.value], provenance: "fan", callbackRoles: ["control"] },
          (f, v) => v,
        ).callbackRoles,
      ).toEqual(["control"]);
    },
  );

  // @ledger: Q4 — LANDED
  it(
    "fold declares the acc chain: srfi-1 `reduce` carries the DECLARED `accumulator` arm " +
      "(via `withCallbackRoles` — a tagless def's contract is shapeless by construction, " +
      "so declaration is the ONLY channel), and `declaresAccChain` reads it as data — the " +
      "chained track-composition source (§3: `egress(Tᵢ) → ingress(Tᵢ₊₁)` is the only " +
      "sanctioned inter-track edge)",
    () => {
      expect(rolesOf(srfi1, "reduce")).toEqual(["accumulator"]);
      expect(declaresAccChain(rolesOf(srfi1, "reduce"))).toBe(true);
      // Parallel-composition hosts do NOT declare an acc chain.
      expect(declaresAccChain(rolesOf(lists, "map"))).toBe(false);
      expect(declaresAccChain(rolesOf(srfi1, "filter"))).toBe(false);
      expect(declaresAccChain(undefined)).toBe(false);
      // withCallbackRoles is non-mutating declaration sugar: the def carries the roles.
      const marked = withCallbackRoles(symbol.tagless`q4-fold: synthetic fold`, ["accumulator"]);
      expect(marked.callbackRoles).toEqual(["accumulator"]);
      expect(declaresAccChain(marked.callbackRoles)).toBe(true);
    },
  );

  // @ledger: Q4 — LANDED
  it(
    "the resolved CallbackRole[] rides the BOUND callable via the same stamp path as the " +
      "top-level role (capability.ts) — Q3/Q8a read `.callbackRoles` off `env.get(op)` as " +
      "data, uniformly across native/sequence/tagless/rosetta kinds",
    async () => {
      const env = await freshEnv();
      const read = (op: string): CallbackRoles | undefined =>
        (env.get(op) as { callbackRoles?: CallbackRoles }).callbackRoles;
      // sequence kind (filter — declared override), tagless kind (reduce — withCallbackRoles),
      // native kind (for-each — shape-decided effect).
      expect(read("filter")).toEqual(["control"]);
      expect(read("reduce")).toEqual(["accumulator"]);
      expect(read("for-each")).toEqual(["effect"]);
      expect(read("sort")).toEqual(["control"]);
      // A def with no lambda arms binds with NO callbackRoles stamped.
      expect(read("cons")).toBeUndefined();
      // The stamp seam is the REAL EnvCapability binder end-to-end for a fresh synthetic
      // def too (the kwargs-runtime fixture convention) — fan default rides the binding.
      const def = symbol.native`q4-stamp: synthetic fan`(
        { input: [z.lambda, z.value], output: [z.value], provenance: "fan" },
        (f, v) => v,
      );
      await new EnvCapability("test/q4-stamp", { symbols: { "q4-stamp": def } }).lower({}).apply(env, undefined as never);
      expect(read("q4-stamp")).toEqual(["element-transformer"]);
    },
  );
});

describe("V4 — cone-traversal termination over cyclic binder nodes (§1; PROVENANCE-PLAN.md Q8a′)", () => {
  // @ledger: Q8a′
  it.todo(
    "fullCone/countCone/fieldCone over a `binder{cycles: true}` node TERMINATES — a " +
      "cyclic loop-carried dependency never sends the walker into unbounded recursion " +
      "(the widening interplay Q8a′'s risk register names explicitly)",
  );

  // @ledger: Q8a′
  it.todo(
    "loop wireframing lands template referents BEFORE emission can key records against " +
      "them — a loop-heavy program never emits a record with no template (Q8a′ is a " +
      "HARD gate before Q11a for exactly this reason)",
  );
});

describe("Q7 — program prelude: PURE-only membership, the REJECTED direction (§1 CHOSEN round 2 A3, narrowed round 3 M1; PROVENANCE-PLAN.md Q7)", () => {
  // @ledger: Q7 — LANDED
  it(
    "a define wrapping a fetch-role (source) rosetta is refused prelude membership — " +
      "directly (its own body crosses the port) AND transitively (a caller that never " +
      "touches the port itself, but REFERENCES the port-reaching helper by name, is " +
      "itself port-reaching — §1's fixpoint over the top-level call graph) — " +
      "`assertPreludeEligible` throws a teaching door naming the port (errors-as-doors; " +
      "§1 EXCLUDED \"port-reaching defines in the prelude — name indirection would " +
      "smuggle sources into 'pure' wire bodies\")",
    async () => {
      await initBridge();
      const C: Classifier = { roleOf: (op) => (op === "fetch-thing" ? "source" : undefined) };
      const forms = await parse(
        `(define (helper) (fetch-thing "https://example.invalid"))
         (define (caller) (helper))
         (define (uninvolved) 42)`,
        inferenceEnv,
      );
      const membership = classifyProgramPrelude(forms, C);

      // Direct: helper's own body crosses the declared source port.
      expect(membership.wireframe.has("helper")).toBe(true);
      expect(membership.pure.has("helper")).toBe(false);
      // Transitive: caller's body only references `helper` by name (classify() alone
      // cannot see through the call — the gap this module's fixpoint closes).
      expect(membership.wireframe.has("caller")).toBe(true);
      expect(membership.pure.has("caller")).toBe(false);
      // A genuinely unrelated define stays pure — the rejection doesn't over-taint.
      expect(membership.pure.has("uninvolved")).toBe(true);
      expect(membership.wireframe.has("uninvolved")).toBe(false);

      for (const name of ["helper", "caller"]) {
        let caught: unknown;
        try {
          assertPreludeEligible(name, membership);
        } catch (e) {
          caught = e;
        }
        expect(caught).toBeInstanceOf(PreludeMembershipError);
        expect((caught as PreludeMembershipError).message).toMatch(/port/i);
      }
      // The eligible one throws nothing.
      expect(() => assertPreludeEligible("uninvolved", membership)).not.toThrow();
    },
  );
});
