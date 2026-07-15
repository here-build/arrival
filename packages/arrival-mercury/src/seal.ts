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
 * ─── T6c CLOSED (2026-07-16): the re-point ──────────────────────────────────────
 *
 * This function used to consume `WireVerdict` from `wire/policy` — the OLD,
 * purely-structural static leg with no integrity concept — and this block
 * documented that migration as "KNOWN MIGRATION STATE" while it was in flight.
 * T6c is closed: `seal()` now takes `CircuitVerdict` (verdict/circuit-verdict.ts)
 * directly, whose `dataShaped`/`judgmentShaped` check `Integrity`
 * (evidence/ambient/program-text, invention I3) — an ambient-rooted leaf
 * (`(now)`/`(uuid)`) is refused by a DESIGNED boundary, not an accident of probe
 * coverage. The vocabulary check (a judgment leaf's selection against the
 * DECLARED output schema) is carried by the caller alongside the re-pointed
 * static leg — see mcp-worker's `attest-provider.ts::judgmentVocabularyOf` for
 * the live conjunction's own derivation of that vocabulary. The probe-coverage
 * ordering constraint this block used to warn about (never generalize the probe
 * to non-infer/ambient crossings BEFORE this re-point lands) is now a PROVED
 * invariant, not a posture — see `src/__tests__/seal-ambient-ordering.test.ts`.
 *
 * `wire/policy.ts`'s `WireVerdict`/`dataShaped`/`judgmentShaped`/`verdictFor`
 * remain in the tree as the PREDECESSOR plane: `probe-adversarial.test.ts` and
 * `wire-descriptor.test.ts` still exercise them directly (TESTING.md §2/§3:
 * "stays green until wire/ dissolves, per losable-legacy") as an independent,
 * still-passing mechanism check — that dissolution is a separate, explicit step,
 * not a side effect of this re-point.
 */
import type { LeafVerdictKind } from "./probe/verdict.js";
import type { CircuitVerdict } from "./verdict/circuit-verdict.js";

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
 * What a leaf was expected to be, ahead of checking it — the seal's own
 * declaration, never inferred from the circuit (the design's own "the policy is
 * specification, not a guess the checker makes from shape alone"). Owned HERE,
 * not by `verdict/circuit-verdict.ts`'s `CircuitRole` (a bare `"data" |
 * "judgment"` string with no vocabulary): `CircuitRole` answers "is the circuit
 * SHAPED like a judgment," a structural question the circuit module can answer
 * with no schema in hand; this type's `vocabulary` is the DECLARED output
 * schema the conjunction checks the observed selection against — a downstream
 * concern `circuit-verdict.ts` explicitly declines to own (see its module
 * header's `judgmentShaped` doc). `wire/policy.ts` keeps its OWN, independent
 * copy of this same shape for its (predecessor-plane) `verdictFor` — that is not
 * a DRY violation: wire/policy is the retiring plane (TESTING.md's
 * "losable-legacy"), and this copy is the one the LIVE conjunction owns.
 */
export type LeafRole = { readonly role: "data" } | { readonly role: "judgment"; readonly vocabulary: ReadonlySet<string> };

/**
 * Compose one leaf's two plane-verdicts into the sealed decision.
 *
 * @param staticVerdict  `circuitVerdict(prov, role.role)` (verdict/circuit-verdict.ts)
 *                       — the static, integrity-aware circuit reading.
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
export function seal(staticVerdict: CircuitVerdict, probeVerdict: LeafVerdictKind, role: LeafRole): SealVerdict {
  if (role.role === "data") {
    // Static gate FIRST: only a clean-content circuit is a candidate.
    if (staticVerdict !== "data-shaped") {
      return notAttestable(`static plane did not certify clean content (${staticVerdict}); the probe cannot upgrade it`);
    }
    // Dynamic gate: the probe must have OBSERVED a mark flow to this leaf.
    if (probeVerdict !== "content") {
      return notAttestable(`static content unconfirmed by probe (probe: ${probeVerdict}) — flow may cancel or the crossing may be absent`);
    }
    return { kind: "content-attested" };
  }

  // Judgment role.
  if (staticVerdict !== "judgment-shaped") {
    return notAttestable(`static plane did not certify a declared judgment (${staticVerdict}); the probe cannot upgrade it`);
  }
  // The leaf must be OBSERVED to range among the program's own constants —
  // `selection`, not `content` (content here would mean a mark leaked into a
  // verdict slot, which is itself a fabrication of the vocabulary).
  if (probeVerdict !== "selection") {
    return notAttestable(`static judgment unconfirmed by probe (probe: ${probeVerdict}) — expected selection among declared constants`);
  }
  return { kind: "selection-attested", vocabulary: role.vocabulary };
}
