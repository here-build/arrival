/**
 * T6c's own ordering invariant, made executable.
 *
 * `seal.ts`'s retired "KNOWN MIGRATION STATE" block (pre-T6c) warned of a
 * consequence it called PROBE COVERAGE: `runProbe` perturbs ONLY `infer`/
 * `infer/chat` mint anchors — never an ambient crossing (`(now)`, `(uuid)`).
 * Generalizing the probe to ambient crossings BEFORE the static leg became
 * integrity-aware would have opened the "ambient laundering" forge —
 * `(string-append "case-" (number->string (now)))` signing as content on the
 * strength of probe movement ALONE, with no static veto (the predecessor
 * `wire/policy` plane has no integrity concept at all, so it cannot tell an
 * ambient mint from a genuine evidence crossing). The block's law: "Probe
 * generalization MUST lag the re-point."
 *
 * The re-point is now done — `seal()` takes `CircuitVerdict`
 * (verdict/circuit-verdict.ts), whose `dataShaped` requires every content
 * anchor to be `integrity:"evidence"` (Biba 1977 low-water-mark, invention
 * I3). This suite is the permanent guard that PROVES the ordering constraint
 * is satisfied, rather than merely asserting it in prose (mirroring seal.ts's
 * own precedent for the guard-swap forge: "the corpus is the guard, not this
 * comment"): the static leg refuses an ambient-rooted leaf ON ITS OWN, and no
 * probe verdict — including "content", the exact reading a future generalized
 * probe could produce for an ambient crossing — can make the seal attest it.
 * That is precisely the property that makes generalizing the probe to
 * non-infer/ambient crossings SAFE going forward.
 */
import { describe, expect, it } from "vitest";

import type { NodeId } from "../coreform/types.js";
import type { FusedProv, MintProv } from "../model/static-prov.js";
import type { LeafVerdictKind } from "../probe/verdict.js";
import { seal, type LeafRole } from "../seal.js";
import { circuitVerdict } from "../verdict/circuit-verdict.js";

const S = 0 as NodeId; // dummy site — never compared on (circuit-verdict.ts's own ChannelAnchor doc)

describe("seal ordering invariant — the integrity-aware static leg gates ambient content independent of the probe", () => {
  // (string-append "case-" (number->string (now))) — seal.ts's own retired
  // migration-block worked example, hand-built as the circuit `extract` would
  // produce for it: an ambient mint reaching a content position.
  const ambientMint: MintProv = { kind: "mint", site: S, head: "now", integrity: "ambient", closed: [] };
  const ambientContent: FusedProv = { kind: "fused", site: S, sources: [ambientMint] };

  it("the static circuit leg alone refuses ambient content — not-attestable, no probe needed", () => {
    expect(circuitVerdict(ambientContent, "data")).toBe("not-attestable");
  });

  it('even a probe verdict of "content" — the exact reading a generalized probe COULD produce for an ambient crossing — cannot flip the seal: the static gate vetoes first, for every possible probe reading', () => {
    const staticVerdict = circuitVerdict(ambientContent, "data");
    const role: LeafRole = { role: "data" };
    const everyProbeReading: readonly LeafVerdictKind[] = ["content", "selection", "ungrounded", "indeterminate"];
    for (const probeVerdict of everyProbeReading) {
      const sealed = seal(staticVerdict, probeVerdict, role);
      expect(sealed.kind).toBe("not-attestable");
    }
  });

  it("contrast: an EVIDENCE-class mint in the identical shape is NOT vetoed — the refusal above is about integrity, not merely about being a mint", () => {
    const evidenceMint: MintProv = { kind: "mint", site: S, head: "infer", integrity: "evidence", closed: [] };
    const evidenceContent: FusedProv = { kind: "fused", site: S, sources: [evidenceMint] };
    const evidenceStatic = circuitVerdict(evidenceContent, "data");
    expect(evidenceStatic).toBe("data-shaped");
    expect(seal(evidenceStatic, "content", { role: "data" }).kind).toBe("content-attested");
  });
});
