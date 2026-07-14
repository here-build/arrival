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
 * The static gate SUBSUMES the same-path requirement: a branch-swap-forgeable
 * leaf is never statically clean content — it is a `Hole` (opaque dispatch the
 * static walk cannot see through) or a `Case` (a visible guard). So excluding
 * non-`data-shaped` descriptors excludes every forge the probe could
 * manufacture; where the static plane is BLIND (a `Hole`), `not-attestable` is
 * the fail-closed answer and the probe cannot upgrade it.
 *
 * Seal = static ∧ probe, fail closed on ANY disagreement or indeterminacy.
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
 * The two verdicts MUST describe the SAME leaf — the caller is responsible for
 * pairing them by leaf path (the static `LeafPath` ↔ dynamic `LeafPath`
 * correspondence). This function trusts that pairing and does not re-check it;
 * a mispaired call is a caller bug, not a seal a mismatch could forge (both
 * planes still have to independently pass, so a wrong pairing can only ever
 * DOWNGRADE, never upgrade).
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
