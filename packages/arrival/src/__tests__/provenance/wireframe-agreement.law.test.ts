/**
 * LAW — wire-locality (GREEN at Q8a), W1 agreement (staged, Q9), I5 exterior collapse
 * (GREEN at Q8a) (docs/PROVENANCE.md §1 "Model", §3 I5, §7 law table;
 * docs/PROVENANCE-PLAN.md Q5's stub-file mapping table, Q8a's landing).
 *
 * Three law families share this file because all three are properties OF THE
 * BUILDER'S OUTPUT (the wireframe graph), not of the retrospective stream:
 *
 *   - wire-locality  — an ASSEMBLY-TIME check on every emitted wire (FLIPPED at Q8a:
 *     `provenance/uneval.ts`'s `unevalWire` enforces FV(body) ⊆ params ∪ prelude ∪
 *     hermetic-base AT EMISSION — the `WireLocalityError` door).
 *   - W1 agreement   — the wireframe's cone vs the eager oracle's, SCOPED per the m3
 *     precision trade (flips at Q9 — the oracle harness; NOT this landing's).
 *   - I5 ext. collapse — a region is ONE node from G (FLIPPED at Q8a: a fan's
 *     callback body is the region's PRIVATE `template` interior).
 *
 * Q7 (LANDED) keeps its own describe block below — the PRECURSOR half of
 * wire-locality's by-name row, asserted one layer down (partition + hermetic
 * assembler); the wire-level half is now asserted directly above it.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { initBridge } from "../../index.js";
import { parse, exec } from "../../eval/generator-exec.js";
import { inferenceEnv } from "../../inference-env.js";
import type { Classifier, DeclaredRole } from "../../values/lineage.js";
import { classifyProgramPrelude, buildPreludeSource } from "../../provenance/prelude.js";
import { hermeticEnv } from "../../provenance/hermetic-env.js";
import { buildWireframe } from "../../provenance/wireframe/builder.js";
import { freeVars } from "../../provenance/wireframe/free-vars.js";
import type { WireframeGraph } from "../../provenance/wireframe/types.js";
import { WireLocalityError } from "../../errors.js";
import { scopeId } from "../../provenance/scope-id.js";
import { schemeToJs } from "../../rosetta.js";

// ── Q8a harness: a synthetic declared-role classifier (Q3's shape) + a synthetic
// hermetic-base predicate. Production reads `.provenanceRole` off the sealed chain;
// the LAW is about the builder's output shape, not the role source. ──
const ROLES: Record<string, DeclaredRole> = { "src-a": "source", "fetch-item": "source", "emit!": "sink", map: "fan" };
const CLASSIFIER: Classifier = { roleOf: (op) => ROLES[op] };
const BASE = new Set(["+", "-", "*", ">", "positive?", "car", "cons", "list", "length"]);
const isBaseName = (n: string): boolean => BASE.has(n);

async function wf(code: string) {
  const forms = await parse(code, inferenceEnv);
  return buildWireframe(forms, { classifier: CLASSIFIER, isBaseName });
}

beforeAll(async () => {
  await initBridge();
});

describe("wire-locality (§1 CHOSEN: a wire is a closed arrival lambda) — FLIPPED at Q8a", () => {
  // @ledger: Q8a — FLIPPED (unevalWire's emission check + WireLocalityError door)
  it(
    "FV(wire body) ⊆ params ∪ prelude-names — checked AT EMISSION by `uneval`'s lambda-" +
      "lifting; declared-vs-actual consumption drift is unrepresentable by construction",
    async () => {
      const p = await wf(
        "(define (inc n) (+ n 1))\n(let ((y (src-a))) (if (positive? y) (inc y) (+ y (src-a))))",
      );
      // POSITIVE direction: every emitted wire re-parses CLOSED — its lambda's free
      // variables are only prelude/base names (params are lambda-bound; ingress
      // that isn't a param cannot exist, so drift is unrepresentable).
      const graphs: WireframeGraph[] = [p.main, ...[...p.templates.values()].map((t) => t.graph)];
      let wiresChecked = 0;
      for (const g of graphs) {
        for (const w of g.wires) {
          const [lam] = await parse(w.source, inferenceEnv);
          for (const name of freeVars(lam)) {
            expect(p.prelude.names.has(name) || isBaseName(name), `"${name}" leaked from ${w.source}`).toBe(true);
          }
          wiresChecked++;
        }
      }
      expect(wiresChecked).toBeGreaterThan(0);

      // NEGATIVE direction: the check is AT EMISSION — a wire that would capture a
      // port-reaching define as a value is never minted; the door throws while the
      // builder assembles, not in a later audit pass.
      const violating = await parse("(define (helper x) (src-a x))\n(emit! helper)", inferenceEnv);
      expect(() => buildWireframe(violating, { classifier: CLASSIFIER, isBaseName })).toThrow(
        WireLocalityError,
      );
    },
  );

  // @ledger: Q8a — FLIPPED (γ-applies against the Q7 hermetic env)
  it(
    "a wire body calling a pure prelude helper references it BY NAME — a captured " +
      "reference that resolves to a prelude or native name is NEVER carried as a " +
      "payload (§1 EXCLUDED: \"helpers-as-ingress... a captured native would smuggle a " +
      "JS function into the persisted wire\")",
    async () => {
      const p = await wf("(define (inc n) (+ n 1))\n(emit! (inc x))");
      expect(p.prelude.names.has("inc")).toBe(true);
      const w = p.main.wires[0];
      // by-name: `inc` appears in the body TEXT, never in the parameter list
      expect(w.source).toBe("(lambda (x) (inc x))");
      expect(w.params).toEqual(["x"]);
      expect(w.paramRefs).toEqual([{ kind: "slot", name: "x" }]);

      // γ = apply in the hermetic env (§4): the wire resolves `inc` through the
      // SEALED base+prelude chain — proof the reference needed no payload.
      const env = await hermeticEnv([], p.prelude.source);
      const [result] = await exec(`(${w.source} 41)`, { env, skipBootstrapWait: true });
      expect(schemeToJs(result)).toBe(42);
    },
  );

  // @ledger: Q8a — FLIPPED (wires are serialized source; Pairs-with-spans on re-read)
  it(
    "a JS closure is never a wire carrier — wires serialize as Pairs-with-spans (the " +
      "reader AST) under the tagless algebra, never as an ambient-referencing JS " +
      "function (§1 EXCLUDED: \"not serializable, not content-addressable\")",
    async () => {
      const p = await wf("(+ (src-a) k)");
      const w = p.main.wires.find((x) => x.consumer.slot === "out");
      expect(w).toBeDefined();
      if (w === undefined) return;
      // the carrier is TEXT (content-addressable data), not a function
      expect(typeof w.source).toBe("string");
      for (const v of Object.values(w)) expect(typeof v).not.toBe("function");
      // and it re-reads as located Pairs — the homoiconic iso's data half
      const [lam] = await parse(w.source, inferenceEnv);
      expect((lam as { kind?: string }).kind).toBe("pair");
      expect(scopeId(lam)).toContain("@"); // spans intact on the re-read carrier
    },
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

describe("I5 — exterior collapse (§3: a region is ONE node from G) — FLIPPED at Q8a", () => {
  // @ledger: Q8a — FLIPPED (fan template = the region's private interior)
  it(
    "a region collapses to exactly ONE wireframe node from G, regardless of how many " +
      "interior cones its body computes — structured egress (one value, several " +
      "interior cones) does NOT fragment the region into multiple designated nodes",
    async () => {
      // The callback's structured egress combines a PORT cone (fetch-item) and a
      // pure cone (+ v 1) into one cons — several interior cones, one region value.
      const p = await wf("(car (map (lambda (v) (cons (fetch-item v) (+ v 1))) xs))");
      // From G: the fan is ONE node; the out-port is the only other node. The
      // interior's source did NOT surface as a designated node of G.
      expect(p.main.nodes.map((n) => n.kind).sort()).toEqual(["fan", "port"]);
      const fanIdx = p.main.nodes.findIndex((n) => n.kind === "fan");
      const fan = p.main.nodes[fanIdx];
      if (fan.kind !== "fan") throw new Error("expected fan");
      // the interior EXISTS (replay material) and holds the region's own port
      expect(fan.template?.nodes.map((n) => n.kind).sort()).toEqual(["port", "source"]);
      // exactly ONE wire consumes the region's egress from G
      const consumers = p.main.wires.filter((w) => w.paramRefs.some((r) => r.kind === "node" && r.node === fanIdx));
      expect(consumers).toHaveLength(1);
    },
  );

  // @ledger: Q8a — FLIPPED (structural: no region field-port kind exists; the
  // projection stays wire material; the template interior is the replay answer)
  it(
    "field-demand at a region boundary answers by REPLAY, not by records — region " +
      "field-ports are DEFERRED until a workload demands them (§3 I5 LIMIT)",
    async () => {
      const p = await wf("(:total (map (lambda (v) (fetch-item v)) xs))");
      // Field demand on the region's egress does NOT mint any per-field egress
      // node — the graph still holds exactly the fan and the out-port…
      expect(p.main.nodes.map((n) => n.kind).sort()).toEqual(["fan", "port"]);
      // …the projection rides INSIDE the consuming wire (glass, one γ-step away)…
      const out = p.main.wires.find((w) => w.consumer.slot === "out");
      expect(out?.source).toContain(":total");
      // …and the replay material (the region's template interior) is present —
      // that is HOW a field-demand answers, per the LIMIT.
      const fan = p.main.nodes.find((n) => n.kind === "fan");
      expect(fan?.kind === "fan" && fan.template !== undefined).toBe(true);
    },
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
