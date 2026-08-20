/**
 * THE ADVERSARIAL CORPUS — the security review's own seven attack programs
 * (docs/foundations/arrival-scheme/provenance-by-perturbation.md), each with a
 * MANDATED verdict. This is the mechanism's acceptance test: if these seven
 * pass, the mechanism is real; if any fails, we learn it BEFORE deleting any
 * existing provenance.
 *
 * Every row gets BOTH halves:
 *   - STATIC:  `derive()` (../wire/) over the mission's program text VERBATIM —
 *              never executed, no substitution needed at all (a free `e` is
 *              exactly the boundary-in anchor the walk names `PVertice`).
 *   - DYNAMIC: an EXECUTABLE TRANSLATION run through the probe session
 *              (../probe/) — `e`'s field access `(:field e)` is realized as a
 *              ONE-KEY ALIST built from a real `(infer …)` crossing:
 *                (let ((e (list (cons 'field (car (infer "m" "field"))))))
 *                  …verbatim mission body, :field accessor UNCHANGED…)
 *              per `keyword-accessor-leaf-door.test.ts`'s own proven
 *              alist-read idiom ("B2 PLUS": `(:term (list (cons 'term v)))`
 *              reads `v`). This keeps the CROSSING's raw value exactly the
 *              scalar the mission intends (so `witnessesFor` mints
 *              type-correct perturbations — a boolean flip, a number
 *              sign-flip, a string content/cardinality pair) while the
 *              accessor syntax the mission wrote stays verbatim in the body.
 *              This is the ONLY adaptation; two rows need one more, narrow,
 *              and separately flagged:
 *                - row 4: `hash` is not a shipped builtin here
 *                  (srfi-13.ts explicitly doors "string-hash": "not shipped").
 *                  Substituted with a locally `define`d char-sum-mod-2 helper —
 *                  same "compute an index from e's content" shape, different
 *                  arithmetic.
 *                - row 6: `<non-terminating loop>` is materialized as
 *                  `(define (loop) (loop))`.
 *
 * Where the static wire ALONE settles the verdict (rows 1-4: the AST says
 * selection-vs-content), that is asserted too, confirming the design's own
 * claim that the probe is only load-bearing for the opaque cases (rows 5-7).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { classify } from "../coreform/index.js";
import type { ClassifyResult } from "../coreform/index.js";
import { defaultRegistry } from "../extract/arm-containers.js";
import { extractProgram } from "../extract/index.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import { seal } from "../seal.js";
import { probe, recordRun, type CallRef, type ProbeSession, type ProbeTable } from "../probe/session.js";
import { openRunnerProbeSession } from "./runner-plane.js";
import { leafVerdicts, type ProbeAttempt } from "../probe/verdict.js";
import { witnessesFor, type Witness } from "../probe/witness.js";
import { circuitVerdict, type CircuitVerdict } from "../verdict/circuit-verdict.js";
import { dataShaped, judgmentShaped, verdictFor } from "../wire/policy.js";
import { derive } from "../wire/derive.js";
import type { Case, Literal, PVertice, WireDescriptor } from "../wire/types.js";

/** The full front pipeline (wire-descriptor.test.ts's own convention). */
const cf = (src: string): ClassifyResult => classify(desugar(parseSexprs(src)));

/**
 * The LIVE static leg (T6c) for the `seal()` calls below — extract a REAL
 * `StaticProv` from the EXECUTABLE source (the exact text the probe runs) and
 * read `circuitVerdict` off it. Deliberately over `execSrc`, never the
 * predecessor wire/policy plane's free-`e` "mission text" (`staticSrc` above):
 * the new mechanism grounds anchors through real `mint`/`input` crossings, not
 * a free-floating vertex, and this is exactly what mcp-worker's
 * `attest-provider.ts::sealLeaf` extracts from in production (same recipe:
 * `parseSexprs → desugar → classify → extractProgram(forms, defaultRegistry)`).
 */
const circuitStatic = (execSrc: string, role: "data" | "judgment"): CircuitVerdict =>
  circuitVerdict(extractProgram(cf(execSrc).forms, defaultRegistry), role);

/** Render a WireDescriptor the way the design doc itself renders one (§3):
 *  `PVertice(name) > step > step > result`, recursing into Case/otherArgs so
 *  the printed tree is the FULL descriptor, not just its top. */
function renderWire(desc: WireDescriptor, indent = ""): string {
  const src = desc.source;
  let head: string;
  switch (src.kind) {
    case "PVertice":
      head = `PVertice(${src.anchorName})`;
      break;
    case "Literal":
      head = `Literal(${JSON.stringify(src.lit.value)})`;
      break;
    case "Hole":
      head = `Hole(${src.reason})`;
      break;
    case "Case":
      head =
        `Case(\n${indent}    cond= ${renderWire(src.cond, `${indent}    `)}\n` +
        `${indent}    alts=[${src.alts.map((a) => renderWire(a, `${indent}    `)).join(", ")}]\n${indent}  )`;
      break;
  }
  const steps = desc.steps
    .map((s) => {
      const others =
        s.otherArgs.length > 0
          ? ` [otherArgs: ${s.otherArgs.map((a) => `#${a.argIndex}=${renderWire(a.descriptor, `${indent}      `)}`).join(", ")}]`
          : "";
      return `\n${indent}  > ${s.op}${others}`;
    })
    .join("");
  return `${head}${steps}`;
}

/** Run every witness's probe against ONE target, converting a thrown/timed-out
 *  attempt into `{ kind: "indeterminate" }` — P3's "a failed probe is
 *  indeterminate, never independent" (probe-harness.test.ts's own helper,
 *  reused verbatim: this orchestration policy belongs to the caller, not to
 *  either mechanism module). */
async function attemptAll(
  session: ProbeSession,
  source: string,
  table: ProbeTable,
  target: CallRef,
  witnesses: readonly Witness[],
): Promise<ProbeAttempt[]> {
  const attempts: ProbeAttempt[] = [];
  for (const witness of witnesses) {
    try {
      const { value } = await probe(session, source, table, target, witness.value);
      attempts.push({ witness, outcome: { kind: "value", value } });
    } catch (e) {
      attempts.push({ witness, outcome: { kind: "indeterminate", reason: e instanceof Error ? e.message : String(e) } });
    }
  }
  return attempts;
}

describe("provenance by perturbation — THE ADVERSARIAL CORPUS (security review)", () => {
  let session: ProbeSession;

  beforeAll(async () => {
    session = await openRunnerProbeSession();
  }, 60_000);

  afterAll(async () => {
    await session.dispose();
  }, 30_000);

  it(
    'row 1: (if (:guilty e) "GUILTY" "INNOCENT") — mandated: SELECTION-grounded, never content',
    { timeout: 30_000 },
    async () => {
      // ── STATIC: verbatim mission text, never executed ──
      const staticSrc = `(if (:guilty e) "GUILTY" "INNOCENT")`;
      const leaves = derive(cf(staticSrc));
      expect(leaves).toHaveLength(1);
      const { descriptor } = leaves[0]!;
      // eslint-disable-next-line no-console
      console.log(`row 1 static wire:\n${renderWire(descriptor)}`);

      expect(descriptor.source.kind).toBe("Case"); // the vertex sits in the GUARD
      const caseSrc = descriptor.source as Case;
      expect(caseSrc.cond.source.kind).toBe("PVertice");
      expect((caseSrc.cond.source as PVertice).anchorName).toBe("e");
      expect(caseSrc.alts.every((a) => a.source.kind === "Literal")).toBe(true); // both branches are hand-written constants
      expect(dataShaped(descriptor)).toBe(false); // NEVER content
      expect(judgmentShaped(descriptor, new Set(["GUILTY", "INNOCENT"]))).toBe(true);
      expect(verdictFor(descriptor, { role: "data" }).kind).toBe("fabrication");
      expect(verdictFor(descriptor, { role: "judgment", vocabulary: new Set(["GUILTY", "INNOCENT"]) })).toEqual({
        kind: "judgment-shaped",
      });

      // ── DYNAMIC: executable translation ──
      const table: ProbeTable = [{ call: { model: "m", prompt: "guilty", schema: null, cacheKey: null }, result: true }];
      const execSrc = `(let ((e (list (cons 'guilty (car (infer "m" "guilty")))))) (if (:guilty e) "GUILTY" "INNOCENT"))`;
      const baseline = await recordRun(session, execSrc, table);
      expect(baseline.value).toBe("GUILTY");
      expect(baseline.calls).toHaveLength(1);

      const target = baseline.calls[0]!.ref;
      const witnesses = witnessesFor(true); // booleans admit exactly ONE axis — no material to ever embed a mark in
      expect(witnesses).toHaveLength(1);
      expect(witnesses[0]!.marks).toEqual([]);

      const attempts = await attemptAll(session, execSrc, table, target, witnesses);
      const verdicts = leafVerdicts(baseline.value, attempts);
      expect(verdicts).toHaveLength(1);
      // eslint-disable-next-line no-console
      console.log("row 1 dynamic verdict:", verdicts[0]);
      expect(verdicts[0]!.verdict).toBe("selection"); // a PROOF (§0) — but never content: structurally impossible for a boolean
      expect(verdicts[0]!.marks).toBeUndefined();
    },
  );

  it(
    'row 2: (string-append (if (:flag e) "A" "B") <10KB of "X">) — mandated: selection; dataShaped FAILS on the literal residue',
    { timeout: 30_000 },
    async () => {
      const bigX = "X".repeat(10_000); // materializing the mission's own "<10KB of X>" placeholder

      const staticSrc = `(string-append (if (:flag e) "A" "B") "${bigX}")`;
      const leaves = derive(cf(staticSrc));
      expect(leaves).toHaveLength(1);
      const { descriptor } = leaves[0]!;
      // eslint-disable-next-line no-console
      console.log(
        `row 2 static wire (bigX elided to "X..."):\n${renderWire(descriptor).replace(new RegExp(bigX, "g"), "X…(10000 X's)…X")}`,
      );

      expect(descriptor.source.kind).toBe("Case"); // vertex in the guard, same shape as row 1
      expect(descriptor.steps).toHaveLength(1);
      const step = descriptor.steps[0]!;
      expect(step.op).toBe("string-append");
      expect(step.otherArgs).toHaveLength(1);
      const residueDesc = step.otherArgs[0]!.descriptor;
      expect(residueDesc.source.kind).toBe("Literal"); // an AString LITERAL as otherArg
      expect((residueDesc.source as Literal).lit.value).toEqual({ kind: "string", value: bigX });
      expect(residueDesc.steps).toEqual([]); // bare literal, no steps on top — the residue IS the node
      expect(dataShaped(descriptor)).toBe(false); // dataShaped ⇒ FAIL

      const table: ProbeTable = [{ call: { model: "m", prompt: "flag", schema: null, cacheKey: null }, result: true }];
      const execSrc = `(let ((e (list (cons 'flag (car (infer "m" "flag")))))) (string-append (if (:flag e) "A" "B") "${bigX}"))`;
      const baseline = await recordRun(session, execSrc, table);
      expect(baseline.value).toBe(`A${bigX}`);

      const target = baseline.calls[0]!.ref;
      const witnesses = witnessesFor(true);
      const attempts = await attemptAll(session, execSrc, table, target, witnesses);
      const verdicts = leafVerdicts(baseline.value, attempts);
      expect(verdicts).toHaveLength(1); // string-append isn't a split compound — one scalar leaf
      // eslint-disable-next-line no-console
      console.log("row 2 dynamic verdict:", { ...verdicts[0], reason: "(elided)" });
      expect(verdicts[0]!.verdict).toBe("selection");
    },
  );

  it(
    'row 3: (cons (:name e) "FABRICATED_ANALYSIS") — mandated PER-LEAF: car content-grounded, cdr UNGROUNDED',
    { timeout: 30_000 },
    async () => {
      const staticSrc = `(cons (:name e) "FABRICATED_ANALYSIS")`;
      const leaves = derive(cf(staticSrc));
      expect(leaves).toHaveLength(2);
      const carLeaf = leaves.find((l) => l.path.length === 1 && l.path[0] === "car")!;
      const cdrLeaf = leaves.find((l) => l.path.length === 1 && l.path[0] === "cdr")!;
      // eslint-disable-next-line no-console
      console.log(`row 3 static wire car:\n${renderWire(carLeaf.descriptor)}\nrow 3 static wire cdr:\n${renderWire(cdrLeaf.descriptor)}`);

      expect(carLeaf.descriptor.source.kind).toBe("PVertice");
      expect(dataShaped(carLeaf.descriptor)).toBe(true);
      expect(cdrLeaf.descriptor.source.kind).toBe("Literal");
      expect(dataShaped(cdrLeaf.descriptor)).toBe(false);

      const recordedName = "Real Person Name";
      const table: ProbeTable = [{ call: { model: "m", prompt: "name", schema: null, cacheKey: null }, result: recordedName }];
      const execSrc = `(let ((e (list (cons 'name (car (infer "m" "name")))))) (cons (:name e) "FABRICATED_ANALYSIS"))`;
      const baseline = await recordRun(session, execSrc, table);
      // A dotted pair egresses as a 2-element array — the improper tail folds in
      // as the last element (APair.ts's own "one-way list→array projection").
      expect(baseline.value).toEqual([recordedName, "FABRICATED_ANALYSIS"]);

      const target = baseline.calls[0]!.ref;
      const witnesses = witnessesFor(recordedName);
      expect(witnesses.length).toBeGreaterThanOrEqual(2);
      const attempts = await attemptAll(session, execSrc, table, target, witnesses);
      const verdicts = leafVerdicts(baseline.value, attempts);
      expect(verdicts).toHaveLength(2);
      const carVerdict = verdicts.find((v) => v.path.length === 1 && v.path[0] === 0)!;
      const cdrVerdict = verdicts.find((v) => v.path.length === 1 && v.path[0] === 1)!;
      // eslint-disable-next-line no-console
      console.log("row 3 dynamic verdicts:", { car: carVerdict, cdr: cdrVerdict });
      expect(carVerdict.verdict).toBe("content");
      expect(cdrVerdict.verdict).toBe("ungrounded");
    },
  );

  it(
    "row 4: (list-ref (list \"fake-a\" \"fake-b\") (modulo (hash (:id e)) 2)) — mandated: fabrication (undeclared vocabulary)",
    { timeout: 30_000 },
    async () => {
      // STATIC — verbatim mission text (never executed: `hash` is not a shipped
      // builtin in this interpreter build — see the DYNAMIC half below).
      const staticSrc = `(list-ref (list "fake-a" "fake-b") (modulo (hash (:id e)) 2))`;
      const leaves = derive(cf(staticSrc));
      expect(leaves).toHaveLength(1);
      const { descriptor } = leaves[0]!;
      // eslint-disable-next-line no-console
      console.log(`row 4 static wire:\n${renderWire(descriptor)}`);

      // MECHANISM FINDING: this is NOT Case-shaped (it's list-ref, not if/Case) —
      // judgmentShaped's Case-only recognition rejects it UNCONDITIONALLY, for
      // EITHER a correct or an incorrect declared vocabulary — the failure mode
      // is a SHAPE mismatch, not (as the mission's own phrasing implies) a
      // vocabulary-declaration failure.
      expect(descriptor.source.kind).not.toBe("Case");
      expect(judgmentShaped(descriptor, new Set(["fake-a", "fake-b"]))).toBe(false); // even the CORRECT vocabulary
      expect(judgmentShaped(descriptor, new Set(["unrelated"]))).toBe(false); // and a wrong one — same false, different reason
      expect(verdictFor(descriptor, { role: "judgment", vocabulary: new Set(["fake-a", "fake-b"]) })).toEqual({
        kind: "not-attestable", // NOT "fabrication" — the mission's predicted verdict is reached only via role:"data" below
      });

      // Checked under role:"data" instead, the residue policy DOES flag it —
      // but for an INCIDENTAL reason (the modulo's literal 2, and the list's
      // second string "fake-b"), not because the seal recognized a declared
      // judgment vocabulary at all.
      const dataVerdict = verdictFor(descriptor, { role: "data" });
      expect(dataVerdict.kind).toBe("fabrication");
      expect(dataShaped(descriptor)).toBe(false);

      // DYNAMIC — executable translation: `hash` substituted with a locally
      // defined char-sum-mod-2 helper (srfi-13.ts doors "string-hash": "not
      // shipped; use an explicit key / dict path, not a hash of the text" — no
      // generic `hash` exists to call here at all).
      const recordedId = "identity-A";
      const table: ProbeTable = [{ call: { model: "m", prompt: "id", schema: null, cacheKey: null }, result: recordedId }];
      const execSrc = `
        (define (mod-hash s) (modulo (apply + (map char->integer (string->list s))) 2))
        (let ((e (list (cons 'id (car (infer "m" "id"))))))
          (list-ref (list "fake-a" "fake-b") (mod-hash (:id e))))
      `;
      const baseline = await recordRun(session, execSrc, table);
      expect(["fake-a", "fake-b"]).toContain(baseline.value);

      const target = baseline.calls[0]!.ref;
      // A hand-built, GUARANTEED-flip witness: appending exactly one
      // odd-char-code character ("!" = 33) always flips a char-sum's parity,
      // regardless of the original string's own sum — deterministic, no
      // reliance on witnessesFor's randomUUID() luck (which would flip the
      // bucket only ~50% of the time per axis).
      const flippedId = `${recordedId}!`;
      const witness: Witness = {
        axis: "content",
        value: flippedId,
        marks: [flippedId],
        label: `content: parity-flipped id "${flippedId}"`,
      };
      const attempts = await attemptAll(session, execSrc, table, target, [witness]);
      const verdicts = leafVerdicts(baseline.value, attempts);
      expect(verdicts).toHaveLength(1);
      // eslint-disable-next-line no-console
      console.log("row 4 dynamic verdict:", verdicts[0]);
      // The bucket flips (a real, proven dependence) but the leaf's material —
      // "fake-a"/"fake-b" — never CONTAINS the id mark: selection, never content.
      expect(verdicts[0]!.verdict).toBe("selection");
    },
  );

  it(
    "row 5: (+ (- (:v e) (:v e)) 42) — cancelled flow — mandated: UNGROUNDED",
    { timeout: 30_000 },
    async () => {
      const staticSrc = `(+ (- (:v e) (:v e)) 42)`;
      const leaves = derive(cf(staticSrc));
      expect(leaves).toHaveLength(1);
      const { descriptor } = leaves[0]!;
      // eslint-disable-next-line no-console
      console.log(`row 5 static wire (full expr, +42 included):\n${renderWire(descriptor)}`);
      // The +42 glues a bare Literal onto the result — dataShaped fails for
      // THIS reason (a residue), not directly because of the cancellation.
      expect(dataShaped(descriptor)).toBe(false);

      // MECHANISM FINDING: strip the +42 and look at (- (:v e) (:v e)) alone.
      // The static wire is PURELY PVertice-derived with ZERO literal residue —
      // dataShaped flips to TRUE. A genuine STATIC FALSE POSITIVE for "clean
      // content," exactly the §6 divergence the design predicts: the static
      // wire answers FLOW (e's material structurally reaches this computation,
      // over-approximate — "map answers flow… probe answers influence", P5);
      // the probe answers INFLUENCE (does it actually move the value). Only
      // the probe gets this one right — precisely why rows 5-7 need it.
      const cancelledOnlyLeaves = derive(cf(`(- (:v e) (:v e))`));
      // eslint-disable-next-line no-console
      console.log(`row 5 static wire (bare (- e e), no +42):\n${renderWire(cancelledOnlyLeaves[0]!.descriptor)}`);
      expect(dataShaped(cancelledOnlyLeaves[0]!.descriptor)).toBe(true); // the static FALSE POSITIVE

      const table: ProbeTable = [{ call: { model: "m", prompt: "v", schema: null, cacheKey: null }, result: 100 }];
      const execSrc = `(let ((e (list (cons 'v (car (infer "m" "v")))))) (+ (- (:v e) (:v e)) 42))`;
      const baseline = await recordRun(session, execSrc, table);
      expect(Number(baseline.value)).toBe(42);

      const target = baseline.calls[0]!.ref;
      const witnesses = witnessesFor(100);
      expect(witnesses.length).toBeGreaterThanOrEqual(2);
      const attempts = await attemptAll(session, execSrc, table, target, witnesses);
      const verdicts = leafVerdicts(baseline.value, attempts);
      expect(verdicts).toHaveLength(1);
      // eslint-disable-next-line no-console
      console.log("row 5 dynamic verdict:", verdicts[0]);
      // x - x cancels for EVERY witness value, by construction (any x, x - x = 0)
      // — correctly invisible to the probe. The design ADMITS this and says
      // it's right (§6: "for grounding this is correct").
      expect(verdicts[0]!.verdict).toBe("ungrounded");
    },
  );

  it(
    'row 6: (if (= (:v e) 7) "R" <non-terminating loop>) — forced-indeterminacy DOS — mandated: INDETERMINATE, attributed',
    { timeout: 30_000 },
    async () => {
      const staticSrc = `(if (= (:v e) 7) "R" (loop))`;
      const leaves = derive(cf(staticSrc));
      expect(leaves).toHaveLength(1);
      const { descriptor } = leaves[0]!;
      // eslint-disable-next-line no-console
      console.log(`row 6 static wire:\n${renderWire(descriptor)}`);
      expect(descriptor.source.kind).toBe("Case");
      const caseSrc = descriptor.source as Case;
      // The else branch is a NULLARY CALL (0 args) — a static blind spot
      // (Hole), not a "detected infinite loop": the static wire cannot see
      // that `(loop)` never returns, only that it can't see INTO it.
      expect(caseSrc.alts[1]!.source.kind).toBe("Hole");
      expect(dataShaped(descriptor)).toBe(false);

      const table: ProbeTable = [{ call: { model: "m", prompt: "v", schema: null, cacheKey: null }, result: 7 }];
      const execSrc = `(define (loop) (loop)) (let ((e (list (cons 'v (car (infer "m" "v")))))) (if (= (:v e) 7) "R" (loop)))`;
      const baseline = await recordRun(session, execSrc, table);
      expect(baseline.value).toBe("R"); // baseline never evaluates (loop) — if is short-circuit

      const target = baseline.calls[0]!.ref;
      const witnesses = witnessesFor(7); // [content: positive sentinel ≥ 1e6, shape: negative sentinel ≤ -1e6] — BOTH provably ≠ 7
      expect(witnesses.length).toBeGreaterThanOrEqual(2);
      const attempts = await attemptAll(session, execSrc, table, target, witnesses); // every witness ≠ 7 → (loop) → budget exceeded
      // eslint-disable-next-line no-console
      console.log(
        "row 6 attempts:",
        attempts.map((a) => (a.outcome.kind === "indeterminate" ? { kind: "indeterminate", reason: a.outcome.reason } : a.outcome)),
      );
      expect(attempts.every((a) => a.outcome.kind === "indeterminate")).toBe(true);
      for (const a of attempts) {
        if (a.outcome.kind === "indeterminate") expect(a.outcome.reason).toMatch(/execution budget exceeded/i);
      }

      const verdicts = leafVerdicts(baseline.value, attempts);
      expect(verdicts).toHaveLength(1);
      // eslint-disable-next-line no-console
      console.log("row 6 dynamic verdict:", verdicts[0]);
      expect(verdicts[0]!.verdict).toBe("indeterminate"); // never "independent" (P3)
      expect(verdicts[0]!.reason).toMatch(/fails closed/i);
      expect(verdicts[0]!.reason).toMatch(/execution budget exceeded/i); // ATTRIBUTED to the chain, not silent
    },
  );

  it(
    "row 7: (string-length (:id e)) — THE WITNESS-AXIS TEST",
    { timeout: 30_000 },
    async () => {
      const staticSrc = `(string-length (:id e))`;
      const leaves = derive(cf(staticSrc));
      expect(leaves).toHaveLength(1);
      const { descriptor } = leaves[0]!;
      // eslint-disable-next-line no-console
      console.log(`row 7 static wire:\n${renderWire(descriptor)}`);
      expect(descriptor.source.kind).toBe("PVertice");
      // Statically this reads as fully "clean content" — a length is
      // PVertice-derived with zero literal residue. Whether that static
      // verdict is the RIGHT one for a *derived measurement* (not literally
      // "the data") is exactly what the dynamic axis test below probes.
      expect(dataShaped(descriptor)).toBe(true);

      // recordedId chosen at EXACTLY 36 chars — randomUUID()'s own canonical
      // length — so the "content" witness (a fresh UUID, ALWAYS 36 chars by
      // format) leaves string-length UNCHANGED, deterministically isolating
      // the content axis from the length-changing axis.
      const recordedId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      expect(recordedId).toHaveLength(36);
      const table: ProbeTable = [{ call: { model: "m", prompt: "id", schema: null, cacheKey: null }, result: recordedId }];
      const execSrc = `(let ((e (list (cons 'id (car (infer "m" "id")))))) (string-length (:id e)))`;
      const baseline = await recordRun(session, execSrc, table);
      expect(Number(baseline.value)).toBe(36);

      const target = baseline.calls[0]!.ref;
      const witnesses = witnessesFor(recordedId);
      // NOTE: the CODE's axis name for a string's length-changing witness is
      // "cardinality" — the mission's own row text says "SHAPE-axis witness
      // (different-length string)"; "shape" in the shipped code is reserved
      // for number/boolean witnesses (sign-flip / boolean-flip). Same
      // substance (the axis that changes length), different label — noted
      // here rather than silently harmonized.
      expect(witnesses.map((w) => w.axis)).toEqual(["content", "cardinality"]);

      const contentOnly = await attemptAll(session, execSrc, table, target, [witnesses[0]!]);
      const contentOnlyVerdicts = leafVerdicts(baseline.value, contentOnly);
      // eslint-disable-next-line no-console
      console.log("row 7 content-only verdict:", contentOnlyVerdicts[0]);
      expect(contentOnlyVerdicts[0]!.verdict).toBe("ungrounded"); // a same-length UUID swap never moves the LENGTH

      const both = await attemptAll(session, execSrc, table, target, witnesses);
      const bothVerdicts = leafVerdicts(baseline.value, both);
      // eslint-disable-next-line no-console
      console.log("row 7 content+cardinality verdict:", bothVerdicts[0]);
      // The cardinality witness moves the length — a PROOF via SELECTION
      // (never "content": a length can never literally CONTAIN the mark it
      // was computed from — containsMark's number branch requires numeric
      // equality with the mark, not derivation from it).
      expect(bothVerdicts[0]!.verdict).toBe("selection");
      expect(bothVerdicts[0]!.marks).toBeUndefined();
    },
  );

  it(
    'row 8 (RED-TEAM, Finding 1): (if (< (:v e) 1000) "SAFE" (number->string (:v e))) — the GUARD-SWAP forge — probe ALONE says "content", the SEAL says not-attestable',
    { timeout: 30_000 },
    async () => {
      // The attack: the ATTESTED (baseline) output is the hand-written constant
      // "SAFE". A witness that pushes (:v e) over the guard routes the probe
      // down the OTHER branch — (number->string (:v e)) — which legitimately
      // contains the mark. The DYNAMIC plane alone therefore cries "content"
      // and would sign "SAFE" as evidence-grounded. This is the v2-law forge.
      const staticSrc = `(if (< (:v e) 1000) "SAFE" (number->string (:v e)))`;
      const leaves = derive(cf(staticSrc));
      expect(leaves).toHaveLength(1);
      const { descriptor } = leaves[0]!;
      // eslint-disable-next-line no-console
      console.log(`row 8 static wire:\n${renderWire(descriptor)}`);

      // ── STATIC catches it: a Case whose cond reads the guard crossing and
      //    whose FIRST alt is the fabricated "SAFE" literal. A Case with any
      //    non-clean alt is never dataShaped — the static gate SUBSUMES the
      //    same-branch requirement, because every guard-swap forge must expose
      //    exactly this visible guard + literal-fabrication shape. ──
      expect(descriptor.source.kind).toBe("Case");
      const caseSrc = descriptor.source as Case;
      expect(caseSrc.cond.source.kind).toBe("PVertice"); // (:v e) in the guard
      expect(caseSrc.alts[0]!.source.kind).toBe("Literal"); // "SAFE" — the fabrication
      expect((caseSrc.alts[0]!.source as Literal).lit.value).toEqual({ kind: "string", value: "SAFE" });
      expect(dataShaped(descriptor)).toBe(false); // the STATIC gate rejects
      const staticVerdict = verdictFor(descriptor, { role: "data" });
      expect(staticVerdict.kind).toBe("fabrication");

      // ── DYNAMIC alone IS fooled: perturbing (:v e) over the guard swaps the
      //    branch, and the else branch's material contains the mark. ──
      const table: ProbeTable = [{ call: { model: "m", prompt: "v", schema: null, cacheKey: null }, result: 100 }];
      const execSrc = `(let ((e (list (cons 'v (car (infer "m" "v")))))) (if (< (:v e) 1000) "SAFE" (number->string (:v e))))`;
      const baseline = await recordRun(session, execSrc, table);
      expect(baseline.value).toBe("SAFE"); // the attested output IS the constant

      const target = baseline.calls[0]!.ref;
      const witnesses = witnessesFor(100); // content witness = large positive sentinel (≥ 1e6) — over the guard
      const attempts = await attemptAll(session, execSrc, table, target, witnesses);
      const verdicts = leafVerdicts(baseline.value, attempts);
      expect(verdicts).toHaveLength(1);
      const probeVerdict = verdicts[0]!.verdict;
      // eslint-disable-next-line no-console
      console.log("row 8 probe-ALONE verdict (the forge):", verdicts[0]);
      expect(probeVerdict).toBe("content"); // ← THE FORGE: the probe by itself is deceived

      // ── THE SEAL (static ∧ probe), over the LIVE integrity-aware circuit leg
      //    (T6c) — extracted from the SAME execSrc the probe just ran, never the
      //    predecessor wire/policy plane's free-`e` mission text (staticVerdict
      //    above is retained only as the predecessor-plane's own check). ──
      const circuitStaticVerdict = circuitStatic(execSrc, "data");
      expect(circuitStaticVerdict).toBe("not-attestable"); // the circuit leg vetoes too
      const sealed = seal(circuitStaticVerdict, probeVerdict, { role: "data" });
      // eslint-disable-next-line no-console
      console.log("row 8 SEALED verdict:", sealed);
      expect(sealed.kind).toBe("not-attestable"); // fabricated "SAFE" is NEVER signed
      if (sealed.kind === "not-attestable") expect(sealed.reason).toMatch(/static plane did not certify/i);
    },
  );

  it(
    'row 9 (AUDIT Q2): (define (f x) (if (> x 5) "SAFE" x)) (f (:score e)) — the guard-swap forge HIDDEN IN A NAMED HELPER — probe ALONE forges content, the SEAL rejects',
    { timeout: 30_000 },
    async () => {
      // The guard is inside a user-defined helper, exposed as NEITHER a Case nor a
      // Hole until the walk beta-reduces it. Baseline score = 10 (> 5) → the helper
      // returns the constant "SAFE" — a fabrication. A witness that pushes score ≤ 5
      // routes through the other arm (returns the perturbed score) and leaks the mark.
      const staticSrc = `(define (f x) (if (> x 5) "SAFE" x)) (f (:score e))`;
      const { descriptor } = derive(cf(staticSrc))[0]!;
      // eslint-disable-next-line no-console
      console.log(`row 9 static wire (post beta-reduction):\n${renderWire(descriptor)}`);
      // STATIC now sees the guard: beta-reduction exposes the Case with a "SAFE"
      // literal alt — dataShaped FAILS (the fix). Before the fix this was `true`.
      expect(dataShaped(descriptor)).toBe(false);
      const staticVerdict = verdictFor(descriptor, { role: "data" });
      expect(staticVerdict.kind).toBe("fabrication");

      const table: ProbeTable = [{ call: { model: "m", prompt: "score", schema: null, cacheKey: null }, result: 10 }];
      const execSrc = `(define (f x) (if (> x 5) "SAFE" x)) (let ((e (list (cons 'score (car (infer "m" "score")))))) (f (:score e)))`;
      const baseline = await recordRun(session, execSrc, table);
      expect(baseline.value).toBe("SAFE"); // the attested output IS the fabricated constant

      const target = baseline.calls[0]!.ref;
      const witnesses = witnessesFor(10); // shape witness = negative sentinel ≤ -1e6, routes through the else arm
      const attempts = await attemptAll(session, execSrc, table, target, witnesses);
      const probeVerdict = leafVerdicts(baseline.value, attempts)[0]!.verdict;
      // eslint-disable-next-line no-console
      console.log("row 9 probe-ALONE verdict:", probeVerdict);
      expect(probeVerdict).toBe("content"); // ← the forge: the probe by itself is deceived across the hidden branch

      // THE SEAL (static ∧ probe), over the LIVE circuit leg (T6c) — extract's
      // own beta-reduction resolves the named helper `f` exactly as the
      // predecessor wire/derive.ts plane did (both must refuse the hidden
      // guard-swap; staticVerdict above is retained as that predecessor check).
      const circuitStaticVerdict = circuitStatic(execSrc, "data");
      expect(circuitStaticVerdict).toBe("not-attestable");
      const sealed = seal(circuitStaticVerdict, probeVerdict, { role: "data" });
      // eslint-disable-next-line no-console
      console.log("row 9 SEALED verdict:", sealed);
      expect(sealed.kind).toBe("not-attestable");
    },
  );

  it("row 8b: the seal admits a GENUINE content leaf both planes agree on — (string-append (:id e) (:name e))", { timeout: 30_000 }, async () => {
    // The dual of row 8: when there is no fabrication, the seal must not be so
    // paranoid it rejects real evidence. Both branches of a two-crossing
    // append are content; static says data-shaped, probe says content, seal
    // signs. (Guards against a seal that trivially fails everything closed.)
    const staticSrc = `(string-append (:id e) (:name e))`;
    const { descriptor } = derive(cf(staticSrc))[0]!;
    expect(dataShaped(descriptor)).toBe(true);
    expect(verdictFor(descriptor, { role: "data" }).kind).toBe("data-shaped"); // predecessor plane (wire/policy) — unchanged

    const table: ProbeTable = [
      { call: { model: "m", prompt: "id", schema: null, cacheKey: null }, result: "ID-alpha" },
      { call: { model: "m", prompt: "name", schema: null, cacheKey: null }, result: "NAME-beta" },
    ];
    // dict-native evidence (evidence-idiom law, synthesis §2c) — NOT the
    // `(list (cons 'k v))` alist idiom the OTHER rows in this file use. That
    // idiom is a primitives-materialization the circuit leg's mux narrowing
    // cannot see through (a `list`'s BuildProv is keyed POSITIONALLY, so a
    // symbolic `:id`/`:name` mux key never finds a match and the leaf opaques
    // — sound-but-conservative, never a forge, but it CANNOT positively
    // attest). A `dict`'s BuildProv is keyed by its own literal keys, so
    // `(:id e)`/`(:name e)` narrow to the exact part (BKT where-provenance).
    // This mirrors mcp-worker's attest-conjunction.test.ts's own "GENUINE"
    // rows verbatim (its own comment: "The alist idiom (list (cons 'v …)) is
    // a primitives-materialization that seals not-attestable... covered in
    // circuit-verdict's own mux-narrowing suite") — this row NEEDS the
    // circuit leg to positively attest, so it uses the idiom that can.
    const execSrc = `(let ((e (dict :id (car (infer "m" "id")) :name (car (infer "m" "name"))))) (string-append (:id e) (:name e)))`;
    const baseline = await recordRun(session, execSrc, table);
    expect(baseline.value).toBe("ID-alphaNAME-beta");

    // Perturb the FIRST crossing (id); its mark must survive into the append.
    const target = baseline.calls.find((c) => c.signature.prompt === "id")!.ref;
    const witnesses = witnessesFor("ID-alpha");
    const attempts = await attemptAll(session, execSrc, table, target, witnesses);
    const verdicts = leafVerdicts(baseline.value, attempts);
    expect(verdicts[0]!.verdict).toBe("content");

    // THE SEAL, over the LIVE circuit leg (T6c) — same execSrc, both crossings evidence-grounded.
    const circuitStaticVerdict = circuitStatic(execSrc, "data");
    expect(circuitStaticVerdict).toBe("data-shaped");
    const sealed = seal(circuitStaticVerdict, verdicts[0]!.verdict, { role: "data" });
    // eslint-disable-next-line no-console
    console.log("row 8b SEALED verdict (genuine content):", sealed);
    expect(sealed.kind).toBe("content-attested"); // real evidence IS signed
  });
});
