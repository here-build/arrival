/**
 * LAW F1 — one algebra, every carrier (P0/P8).
 *
 * For every tagless term × every carrier: the value result matches reference
 * semantics AND the box discipline matches the term's DECLARED discipline
 * (_tables/terms.ts). The declaration is the law; a carrier cannot negotiate.
 *
 * STUB PHASE: full grid as it.todo — the SHAPE (which cells exist, which are
 * explicit `unsupported`) is the reviewable artifact. Bodies land after:
 *  - R2 ruling (containerBox column), and
 *  - the conservation repair (append/cdr/DR4) — cells for today's known
 *    violations go it.fails first, per docs/test-suite-v2/REMOVAL-MANIFEST.md.
 */
import { describe, it } from "vitest";
import { TERMS } from "./_tables/terms.js";
import { CARRIERS } from "./_tables/carriers.js";

describe.each(TERMS.map((t) => [t.term, t] as const))("term %s", (_name, term) => {
  describe.each(CARRIERS.map((c) => [c.carrier, c] as const))("carrier %s", (_carrier, carrier) => {
    const unsupported = carrier.unsupported.find((u) => u.term === term.term);
    if (unsupported) {
      it.todo(`unsupported by design — doors with: ${unsupported.reason}`);
      return;
    }
    it.todo("value: result matches reference semantics on a 3-element instance");
    it.todo(`boxes: ${term.boxDiscipline} — every consumed element's box obeys the declared discipline`);
    it.todo("provenance: deep-collapsed result provenance ⊇ union of consumed elements' (conservation, P10)");
    it.todo("container box: per R2 ruling [RULING-GATED: R2]");
  });
});
