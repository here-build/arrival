/**
 * The attestation seal — the ONE security decision, and the ONE place the two
 * provenance planes are allowed to combine.
 *
 * Design: docs/foundations/arrival-scheme/provenance-by-perturbation.md §3, "The
 * law (v3 — the probe VALIDATES, it never AUTHORIZES)". A red-team broke the v2
 * law by reading only the dynamic plane: a witness that flips a GUARD routes the
 * probe down a different branch than the baseline, so the probe sees a mark and
 * cries "content" while the ATTESTED (baseline) leaf is a hand-written constant.
 *
 * The fix is a conjunction, and neither conjunct is trusted alone:
 *
 *   - the STATIC plane (src/wire) over-approximates FLOW — it signs
 *     `(- (:v e) (:v e))` because the value flows structurally even though it
 *     cancels — so it must be DOWNGRADED by the probe (invariance ⇒ no real
 *     influence).
 *   - the DYNAMIC plane (src/probe) can be FORGED — by a branch-swap, or by an
 *     ambient constant with no crossing to perturb — so it must be GATED by the
 *     static plane (a Hole/Case leaf, or a leaf whose "vertex" carries a literal
 *     residue, never reaches a content verdict no matter what the probe saw).
 *
 * The static gate SUBSUMES the same-path requirement — but this is a CONTINGENT
 * property of `derive`, not a self-evident truth, and it was already reopened once:
 * a branch-swap forge is caught only if the walk lowers its guard to a visible
 * `Case` or fails closed to a `Hole`. The neutral review found a guard hidden
 * inside a NAMED helper (`(define (f x) (if … "SAFE" x)) (f (:score e))`) that the
 * walk was treating as an opaque forwarding step — neither Case nor Hole — so the
 * gate passed a fabrication. `derive` now BETA-REDUCES user-defined callees, so a
 * helper's guard lowers to `Case` like an inline one, and the only un-inlined
 * callees (recursive / variadic / computed) all fail closed to `Hole`. The
 * invariant the seal depends on is therefore: **`derive` lowers every guard to a
 * `Case` or fails it closed to a `Hole`.** That is maintained BY the walk and
 * checked by the adversarial corpus (probe-adversarial.test.ts) — a future
 * construct that hides a guard as neither would reopen this gap, so the corpus is
 * the guard, not this comment.
 *
 * Where the static plane is BLIND (a `Hole`), `not-attestable` is the fail-closed
 * answer and the probe cannot upgrade it.
 *
 * Seal = static ∧ probe, fail closed on ANY disagreement or indeterminacy.
 *
 * ─── KNOWN MIGRATION STATE (longcat alignment audit, 2026-07-15) ────────────────
 *
 * This function consumes `WireVerdict` from `wire/policy` — the OLD static leg,
 * which is purely STRUCTURAL and has NO integrity concept. The integrity-aware
 * circuit reading (`verdict/circuit-verdict.ts`, invention I3: the
 * evidence/ambient/program-text alphabet) is built and tested but NOT YET in this
 * import graph. Three consequences, all closed together by T6c — do not close
 * any one alone, the intermediate states are forges:
 *
 *   1. AMBIENT BLINDNESS. `wire/policy.dataShaped` signs `(string-append "case-"
 *      (number->string (now)))` — entirely ambient, evidence-free — because the
 *      value flows structurally. The design (§2b, I3) requires the STATIC plane to
 *      refuse ambient-rooted data (verdict `ungrounded-ambient`). Today it is
 *      refused ONLY by an accident of probe coverage (§3 below), not a designed
 *      boundary. `circuit-verdict.dataShaped` DOES check
 *      `anchors.every(a => a.integrity === "evidence")` — T6c must re-point the
 *      static leg here to THAT.
 *   2. VOCABULARY CHECK. `wire/policy.judgmentShaped(desc, vocabulary)` checks the
 *      declared vocabulary; `circuit-verdict.judgmentShaped` does NOT (it defers
 *      to the conjunction). So the re-point in (1) MUST simultaneously carry the
 *      vocabulary check into T6c — re-pointing alone would let an undeclared
 *      constant in a judgment slot seal `selection-attested`. Atomic with (1).
 *   3. PROBE COVERAGE. `runProbe` perturbs ONLY infer crossings; non-infer
 *      crossings (incl. ambient `(now)`/`(uuid)`) re-fire and read `ungrounded`,
 *      which is what accidentally refuses ambient today. Generalizing the probe
 *      to non-infer crossings BEFORE (1) lands opens the ambient forge. Probe
 *      generalization MUST lag the (1) re-point. Written down so it is a posture,
 *      not a surprise.
 */
import type { LeafVerdictKind } from "./probe/verdict.js";
import type { LeafRole, WireVerdict } from "./wire/policy.js";

/**
 * The sealed outcome for one output leaf. `content-attested` / `selection-
 * attested` are the only two POSITIVE seals — both are proofs (a mark was
 * observed to flow, or the leaf was observed to range within a declared
 * vocabulary) STANDING ON a static shape that admits that reading. Everything
 * else is `not-attestable`: the seal never emits a bare "fabrication" verdict,
 * because a security consumer must not distinguish "provably fake" from
 * "unprovable" — both mean DO NOT SIGN.
 */
export type SealVerdict =
  | { readonly kind: "content-attested" }
  | { readonly kind: "selection-attested"; readonly vocabulary: ReadonlySet<string> }
  | { readonly kind: "not-attestable"; readonly reason: string };

const notAttestable = (reason: string): SealVerdict => ({ kind: "not-attestable", reason });

/**
 * Compose one leaf's two plane-verdicts into the sealed decision.
 *
 * @param staticVerdict  `verdictFor(descriptor, role)` — the static wire reading.
 * @param probeVerdict   the leaf's `LeafVerdict.verdict` — the dynamic reading.
 *                       Pass `"indeterminate"` when no probe ran (fail closed).
 * @param role           the declared role the leaf is being sealed against.
 *
 * The two verdicts MUST describe the SAME leaf — the caller pairs them by leaf
 * path (static `LeafPath` ↔ dynamic `LeafPath`). This pairing is PART OF THE
 * TRUSTED BASE, and it is NOT self-defending: a mispairing can UPGRADE, not only
 * downgrade. Counterexample from the corpus — leaf `(- (:v e) (:v e))` is
 * statically data-shaped (its flow structurally reaches `e`) but its probe
 * verdict is `ungrounded` (the value cancels); leaf `(:id e)` has probe verdict
 * `content`. Correctly paired, the first seals `not-attestable`. Cross-paired —
 * the first's static with the second's probe — both halves "independently pass"
 * but for DIFFERENT leaves, and the seal returns `content-attested`: cancelled
 * flow signed as data. So the caller MUST supply a mechanical, verified
 * path-correspondence (the bridge is unbuilt — synthesis §2; today it is
 * hand-written per call site). This function trusts the pairing and cannot
 * re-check it: it holds no leaf identity, only two verdicts.
 */
export function seal(staticVerdict: WireVerdict, probeVerdict: LeafVerdictKind, role: LeafRole): SealVerdict {
  if (role.role === "data") {
    // Static gate FIRST: only a clean-content descriptor is a candidate.
    if (staticVerdict.kind !== "data-shaped") {
      return notAttestable(`static plane did not certify clean content (${staticVerdict.kind}); the probe cannot upgrade it`);
    }
    // Dynamic gate: the probe must have OBSERVED a mark flow to this leaf.
    if (probeVerdict !== "content") {
      return notAttestable(`static content unconfirmed by probe (probe: ${probeVerdict}) — flow may cancel or the crossing may be absent`);
    }
    return { kind: "content-attested" };
  }

  // Judgment role.
  if (staticVerdict.kind !== "judgment-shaped") {
    return notAttestable(`static plane did not certify a declared judgment (${staticVerdict.kind}); the probe cannot upgrade it`);
  }
  // The leaf must be OBSERVED to range among the program's own constants —
  // `selection`, not `content` (content here would mean a mark leaked into a
  // verdict slot, which is itself a fabrication of the vocabulary).
  if (probeVerdict !== "selection") {
    return notAttestable(`static judgment unconfirmed by probe (probe: ${probeVerdict}) — expected selection among declared constants`);
  }
  return { kind: "selection-attested", vocabulary: role.vocabulary };
}
