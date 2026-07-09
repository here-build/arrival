/**
 * LAW (staged) — wire-locality, W1 agreement, I5 exterior collapse (docs/PROVENANCE.md
 * §1 "Model", §3 I5, §7 law table; docs/PROVENANCE-PLAN.md Q5's stub-file mapping table).
 *
 * Q5 CREATES this file as pure `it.todo` staged spec — the wireframe builder (Q8a) and
 * the eager-oracle-vs-wireframe agreement harness (Q9) do not exist yet. Three law
 * families share this file because all three are properties OF THE BUILDER'S OUTPUT
 * (the wireframe graph), not of the retrospective stream:
 *
 *   - wire-locality  — an ASSEMBLY-TIME check on every emitted wire (flips at Q8a).
 *   - W1 agreement   — the wireframe's cone vs the eager oracle's, SCOPED per the m3
 *     precision trade (flips at Q9).
 *   - I5 ext. collapse — a region is ONE node from G (flips at Q8a; the PLAN's own
 *     mapping table stages this row `it.todo` explicitly, independent of Q9).
 *
 * Q7 (LANDED) adds its own describe block below — the PRECURSOR half of
 * wire-locality's "pure prelude helper references it BY NAME" row (still `it.todo`,
 * tagged Q8a, above: that row needs `uneval`'s actual wire-lambda FV check, which
 * doesn't exist yet). Q7 asserts the same fact one layer down, where it's already
 * true today: the partition (`provenance/prelude.ts`) keeps a referenced pure helper
 * prelude-side, and the hermetic assembler (`provenance/hermetic-env.ts`) lands it as
 * an ordinary binding the caller resolves through the SEALED chain — never anything
 * resembling a captured payload.
 */
import { describe, it, expect } from "vitest";
import { initBridge } from "../../index.js";
import { parse, exec } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../inference-env.js";
import type { Classifier } from "../../values/lineage.js";
import { classifyProgramPrelude, buildPreludeSource } from "../../provenance/prelude.js";
import { hermeticEnv } from "../../provenance/hermetic-env.js";
import { schemeToJs } from "../../rosetta.js";

describe("wire-locality (§1 CHOSEN: a wire is a closed arrival lambda)", () => {
  // @ledger: Q8a
  it.todo(
    "FV(wire body) ⊆ params ∪ prelude-names — checked AT EMISSION by `uneval`'s lambda-" +
      "lifting; declared-vs-actual consumption drift is unrepresentable by construction",
  );

  // @ledger: Q8a
  it.todo(
    "a wire body calling a pure prelude helper references it BY NAME — a captured " +
      "reference that resolves to a prelude or native name is NEVER carried as a " +
      "payload (§1 EXCLUDED: \"helpers-as-ingress... a captured native would smuggle a " +
      "JS function into the persisted wire\")",
  );

  // @ledger: Q8a
  it.todo(
    "a JS closure is never a wire carrier — wires serialize as Pairs-with-spans (the " +
      "reader AST) under the tagless algebra, never as an ambient-referencing JS " +
      "function (§1 EXCLUDED: \"not serializable, not content-addressable\")",
  );
});

describe("W1 agreement (§7: eager-oracle cone == wireframe cone, SCOPED per the m3 precision trade)", () => {
  // Verbatim from docs/PROVENANCE.md §1 (round 3, m3) — the precision trade this whole
  // law family is built around, quoted so no future edit "fixes" the scoping by
  // accident: "Do not \"fix\" this by re-recording — the trade IS the ruling."

  // @ledger: Q9
  it.todo(
    "port-coupled decisions and non-mux segments: eager-oracle cone == wireframe cone, " +
      "EXACT equality, over the generated corpus (§7 generator classes: interior " +
      "sources, nested regions, first-class HOFs, structured multi-field egress, " +
      "macro-expanded bodies, deep mux nesting)",
  );

  // @ledger: Q9
  it.todo(
    "pure-mux wires: the RECORD-FREE abstract backward cone of a wire containing a " +
      "pure mux includes BOTH arms' ingress (the wire's params are its full FV set) — " +
      "asserted as the ABSTRACT both-arms cone here; exact arm attribution is Q16's " +
      "pure-mux-derivation law, one γ-step away, NOT this row's job. " +
      'Do not "fix" this by re-recording — the trade IS the ruling.',
  );

  // @ledger: Q9
  it.todo(
    "a pure-selector mux collapses INTO its wire and carries no decision record of its " +
      "own — only port-coupled muxes reach the retrospective stream (§1 CHOSEN, A2)",
  );
});

describe("I5 — exterior collapse (§3: a region is ONE node from G)", () => {
  // @ledger: Q8a
  it.todo(
    "a region collapses to exactly ONE wireframe node from G, regardless of how many " +
      "interior cones its body computes — structured egress (one value, several " +
      "interior cones) does NOT fragment the region into multiple designated nodes",
  );

  // @ledger: Q8a
  it.todo(
    "field-demand at a region boundary answers by REPLAY, not by records — region " +
      "field-ports are DEFERRED until a workload demands them (§3 I5 LIMIT)",
  );
});

describe("Q7 — program prelude: a pure helper stays a REFERENCE, the positive direction (§1 CHOSEN; PROVENANCE-PLAN.md Q7)", () => {
  // @ledger: Q7 — LANDED
  it(
    "a pure helper referenced by name from another define stays a REFERENCE: the " +
      "partition keeps BOTH prelude-side (neither is wireframe material), and the " +
      "hermetic assembler lands the joined prelude source as ordinary bindings the " +
      "calling define resolves through the SEALED chain at ordinary lookup — never as " +
      "an ingress payload (`hermeticEnv` is called with an EMPTY ingress bag below)",
    async () => {
      await initBridge();
      const C: Classifier = { roleOf: () => undefined }; // no declared ports anywhere
      const forms = await parse(
        `(define (helper x) (+ x 1))
         (define (caller y) (helper y))`,
        inferenceEnv,
      );
      const membership = classifyProgramPrelude(forms, C);
      expect(membership.pure.has("helper")).toBe(true);
      expect(membership.pure.has("caller")).toBe(true);
      expect(membership.wireframe.size).toBe(0);

      const prelude = buildPreludeSource(forms, membership);
      const env = await hermeticEnv([], prelude);
      const [result] = await exec("(caller 41)", { env, skipBootstrapWait: true });
      expect(schemeToJs(result)).toBe(42);

      // `helper` is a REAL bound name resolved through the sealed base chain — not
      // something the (empty) ingress bag carried.
      expect(env.get("helper", { throwError: false })).toBeDefined();
    },
  );
});
