/**
 * Leaf verdicts — provenance-by-perturbation.md §0/§3. Given a baseline output
 * value and a family of probe attempts (one per witness, all targeting the
 * SAME crossing instance), classify every LEAF POSITION of the baseline's
 * value tree into the three-way verdict, plus the failure case P3 demands:
 *
 *   content        the leaf's material CONTAINS a witness's mark — the leaf
 *                  is MADE OF what crossed the membrane. PROOF (one witness
 *                  suffices — §0's asymmetry table).
 *   selection      the leaf moved under some witness, but no mark appears —
 *                  it switched among the program's OWN constants. Also PROOF.
 *   ungrounded     every attempted witness left the leaf unchanged. A
 *                  REFUTATION-ATTEMPT, never a proof (P4): independence over
 *                  an infinite domain is not provable from a finite witness
 *                  set.
 *   indeterminate  no witness proved content/selection, and at least one
 *                  attempt crashed/timed out — the failed attempt MIGHT have
 *                  shown movement, so this leaf's status is unknown, not
 *                  refuted. Fails closed, attributed (P3), never silent.
 *
 * ORDER IS THE SOUNDNESS ARGUMENT, not a style choice: a positive proof from
 * ANY successful witness wins outright, even when a DIFFERENT witness for the
 * same target crashed — the crash cannot retroactively undo a proof already
 * found. Only when NO witness proves anything does a failure downgrade
 * "no movement seen" from "ungrounded" to "indeterminate".
 *
 * This is the DYNAMIC leaf-position vocabulary — over the plain JS value tree
 * a run actually egresses. `../wire/types.ts` has a STATIC, differently-shaped
 * `LeafPath` (car/cdr segments over a CoreForm-derived structure, no
 * execution at all); the two are deliberately separate (P5: "two questions,
 * two planes") and this module does not import from `../wire/`.
 */
import { oracleEqual, show } from "../oracle/harness.js";
import type { Witness } from "./witness.js";

/** A leaf's address inside a (possibly nested) output value: an array index
 *  or an object key, root-to-leaf. The root value itself (a bare scalar, or
 *  an empty array/object) is the empty path. */
export type LeafPath = readonly (string | number)[];

export type LeafVerdictKind = "content" | "selection" | "ungrounded" | "indeterminate";

export interface LeafVerdict {
  readonly path: LeafPath;
  readonly verdict: LeafVerdictKind;
  /** Present only for "content" — the mark(s) found in the leaf's material. */
  readonly marks?: readonly string[];
  readonly reason: string;
}

/**
 * One witness's probe attempt: either the probed run's observable value, or a
 * failure — P3's "indeterminate, never independent", made structural so
 * `leafVerdicts` never has to distinguish crash from timeout itself; whatever
 * drove `probe()` already did, in `reason`.
 */
export type ProbeOutcome =
  | { readonly kind: "value"; readonly value: unknown }
  | { readonly kind: "indeterminate"; readonly reason: string };

export interface ProbeAttempt {
  readonly witness: Witness;
  readonly outcome: ProbeOutcome;
}

/** Distinguishes "the path resolved to JS `undefined`" from "the path does
 *  not exist in this tree at all" — a cardinality/key-set witness can shrink
 *  a container so a baseline leaf's position has nothing under it in the
 *  probed tree, and that absence IS a movement, not a no-op. */
const ABSENT = Symbol("probe:absent-path");

function isPlainObjectLike(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/** Enumerate every leaf position of `value`'s tree: scalars are leaves; an
 *  empty array/object is itself a leaf (nothing under it to descend into). */
function leafPaths(value: unknown, prefix: LeafPath = []): LeafPath[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [prefix];
    return value.flatMap((v, i) => leafPaths(v, [...prefix, i]));
  }
  if (isPlainObjectLike(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return [prefix];
    return keys.flatMap((k) => leafPaths(value[k], [...prefix, k]));
  }
  return [prefix];
}

/** Read `path` out of `value`; `ABSENT` when the path cannot be walked to the
 *  end (a container shrank, or a leaf's ex-container is now a scalar). */
function readPath(value: unknown, path: LeafPath): unknown {
  let cur = value;
  for (const step of path) {
    if (Array.isArray(cur) && typeof step === "number") {
      if (step < 0 || step >= cur.length) return ABSENT;
      cur = cur[step];
    } else if (isPlainObjectLike(cur) && typeof step === "string") {
      if (!Object.hasOwn(cur, step)) return ABSENT;
      cur = cur[step];
    } else {
      return ABSENT;
    }
  }
  return cur;
}

function leafChanged(baselineLeaf: unknown, probedLeaf: unknown): boolean {
  const baseAbsent = baselineLeaf === ABSENT;
  const probeAbsent = probedLeaf === ABSENT;
  if (baseAbsent || probeAbsent) return baseAbsent !== probeAbsent;
  return !oracleEqual(baselineLeaf, probedLeaf);
}

/**
 * Does `leaf`'s material contain `mark`? String containment is the primary
 * detector (§2.3: "a fresh UUID inside a string field"); a number leaf
 * matches a numeric or stringified mark (a sentinel that survived arithmetic
 * untouched, or was interpolated into a larger message). Anything else
 * (boolean, null, a container standing in as an empty leaf) can never carry a
 * mark — a boolean cannot BE a UUID.
 */
function containsMark(leaf: unknown, mark: string): boolean {
  if (typeof leaf === "string") return leaf.includes(mark);
  if (typeof leaf === "number" && Number.isFinite(leaf)) return String(leaf) === mark || leaf === Number(mark);
  return false;
}

/**
 * Classify every leaf of `baseline` against `attempts` (each one witness's
 * outcome, all targeting the same crossing instance). See the file header for
 * the ordering/soundness argument.
 */
export function leafVerdicts(baseline: unknown, attempts: readonly ProbeAttempt[]): LeafVerdict[] {
  return leafPaths(baseline).map((path): LeafVerdict => {
    const baselineLeaf = readPath(baseline, path);
    const baselineShown = baselineLeaf === ABSENT ? undefined : baselineLeaf;
    let selectionReason: string | undefined;
    const failures: string[] = [];

    for (const { witness, outcome } of attempts) {
      if (outcome.kind === "indeterminate") {
        failures.push(`"${witness.label}": ${outcome.reason}`);
        continue;
      }
      const probedLeaf = readPath(outcome.value, path);
      if (!leafChanged(baselineLeaf, probedLeaf)) continue; // no movement under this witness

      const probedShown = probedLeaf === ABSENT ? undefined : probedLeaf;
      const mark = witness.marks.find((m) => containsMark(probedShown, m));
      if (mark !== undefined) {
        // CONTENT is a proof — one witness suffices (§0). Return immediately: an
        // unrelated witness's later crash cannot undo a proof already found.
        return {
          path,
          verdict: "content",
          marks: [mark],
          reason:
            `witness "${witness.label}" moved this leaf from ${show(baselineShown)} to ${show(probedShown)}, ` +
            `which contains the witness's mark "${mark}" — the leaf is made of what crossed the membrane`,
        };
      }
      // SELECTION is also a proof, but a LATER witness might still prove content —
      // content outranks selection, so keep scanning instead of returning now.
      selectionReason ??=
        `witness "${witness.label}" moved this leaf from ${show(baselineShown)} to ${show(probedShown)} with no mark ` +
        `material present — selection among the program's own constants`;
    }

    if (selectionReason !== undefined) return { path, verdict: "selection", reason: selectionReason };

    if (failures.length > 0) {
      return {
        path,
        verdict: "indeterminate",
        reason:
          `no witness proved dependence, and ${failures.length} probe(s) failed before answering (${failures.join("; ")}) — ` +
          `cannot rule out that a working probe would have moved this leaf; fails closed (P3)`,
      };
    }

    return {
      path,
      verdict: "ungrounded",
      reason:
        `unchanged across all ${attempts.length} witness(es) attempted` +
        (attempts.length < 2 ? " — below the two-witness floor (P4), so even this is a weak refutation-attempt" : "") +
        ` — a refutation-attempt, never a proof (P4): independence over an infinite domain is not provable by any finite witness set`,
    };
  });
}
