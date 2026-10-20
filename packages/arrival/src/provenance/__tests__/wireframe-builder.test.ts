/**
 * Q8a — WIREFRAME BUILDER CORE rows (docs/PROVENANCE.md
 * §1 "Model", §2 lowering, §3 I5). Unit rows for the builder itself; the LAW rows
 * (wire-locality at emission, I5 exterior collapse) live in
 * `src/__tests__/provenance/wireframe-agreement.law.test.ts` and flip with this
 * landing. Loop interiors (binder backedge wiring) are Q8a′ — staged `it.todo`
 * below, tagged.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { parse } from "../../eval/generator-exec.js";
import type { Classifier, DeclaredRole } from "../lineage.js";
import { buildWireframe } from "../wireframe/builder.js";
import { classifyProgramPrelude } from "../prelude.js";
import { referencedSymbols } from "../slice.js";
import type { Wire, WireframeGraph, WireframeProgram } from "../wireframe/types.js";
import { freeVars } from "../wireframe/free-vars.js";
import { reachableNodes } from "../wireframe/loops.js";
import { unboundSlots } from "../wireframe/validate.js";

// Declared roles (Q3's shape — synthetic here; production reads `.provenanceRole`).
const ROLES: Record<string, DeclaredRole> = {
  "src-a": "source",
  "src-b": "source",
  "fetch-item": "source",
  "emit!": "sink",
  dedent: "transparent",
  map: "fan",
  filter: "fan",
  "black-box": "opaque",
};
const C: Classifier = { roleOf: (op) => ROLES[op] };

// The hermetic-base predicate — a synthetic subset of base-pack names the test
// programs use (production derives this from the sealed base chain).
const BASE = new Set([
  "+",
  "-",
  "*",
  "/",
  ">",
  "<",
  "=",
  ">=",
  "positive?",
  "not",
  "car",
  "cdr",
  "cons",
  "list",
  "length",
  "equal?",
]);
const isBaseName = (n: string): boolean => BASE.has(n);

async function wf(code: string): Promise<WireframeProgram> {
  const forms = await parse(code);
  return buildWireframe(forms, { classifier: C, isBaseName });
}

const kinds = (g: WireframeGraph): string[] => g.nodes.map((n) => n.kind);
const wireTo = (g: WireframeGraph, slot: string): Wire | undefined => g.wires.find((w) => w.consumer.slot === slot);

beforeAll(async () => {});

describe("Q8a builder core — the collapse rule (§1: maximal pure subgraphs fold to ONE wire)", () => {
  it("(emit! (+ (* x x) 5)) — the pure interior is ONE wire, param = its FV, sink is the node", async () => {
    const p = await wf("(emit! (+ (* x x) 5))");
    expect(kinds(p.main)).toEqual(["sink"]); // sink egresses nothing → no out-port
    expect(p.main.egress).toBeNull();
    expect(p.main.wires).toHaveLength(1);
    const w = p.main.wires[0];
    expect(w.consumer).toEqual({ node: 0, slot: "arg0" });
    expect(w.params).toEqual(["x"]);
    expect(w.paramRefs).toEqual([{ kind: "slot", name: "x" }]);
    expect(w.source).toBe("(lambda (x) (+ (* x x) 5))");
  });

  it("two sources cut out of one pure residue — wire params reference the port nodes", async () => {
    const p = await wf("(emit! (+ (src-a) (src-b)))");
    expect(kinds(p.main).sort()).toEqual(["sink", "source", "source"]);
    const sinkIdx = p.main.nodes.findIndex((n) => n.kind === "sink");
    const w = p.main.wires.find((x) => x.consumer.node === sinkIdx);
    expect(w).toBeDefined();
    expect(w?.paramRefs.map((r) => r.kind)).toEqual(["node", "node"]);
    // the residue keeps its shape, ports replaced by minted ingress params
    expect(w?.source).toBe("(lambda (in0 in1) (+ in0 in1))");
  });

  it("the program's value flows to ONE out-port node through the egress wire", async () => {
    const p = await wf("(+ (src-a) 1)");
    expect(kinds(p.main).sort()).toEqual(["port", "source"]);
    expect(p.main.egress).not.toBeNull();
    const w = wireTo(p.main, "out");
    expect(w?.paramRefs).toEqual([
      { kind: "node", name: "in0", node: p.main.nodes.findIndex((n) => n.kind === "source") },
    ]);
    expect(w?.source).toBe("(lambda (in0) (+ in0 1))");
  });

  it("transparent is a designated crossing node (a membrane FACT), not silently a pipe", async () => {
    const p = await wf("(emit! (dedent (+ x 1)))");
    expect(kinds(p.main).sort()).toEqual(["sink", "transparent"]);
  });
});

describe("Q8a builder core — selector-cone reachability decides mux fate (§1 A2 + amendment 1)", () => {
  it("pure-selector mux collapses INTO its wire: params are the full FV set, BOTH arms' ingress (m3)", async () => {
    const p = await wf("(if (> x 0) x (- y x))");
    expect(kinds(p.main)).toEqual(["port"]); // no mux node — collapsed
    const w = wireTo(p.main, "out");
    expect(w?.params.toSorted()).toEqual(["x", "y"]); // both arms' ingress, the m3 trade
    expect(w?.source).toContain("(if (> x 0) x (- y x))");
  });

  it("a mux whose selector directly crosses a port stays EXPANDED (port-coupled)", async () => {
    const p = await wf("(if (positive? (src-a)) x y)");
    expect(kinds(p.main).sort()).toEqual(["mux", "port", "source"]);
    const muxIdx = p.main.nodes.findIndex((n) => n.kind === "mux");
    const sel = p.main.wires.find((w) => w.consumer.node === muxIdx && w.consumer.slot === "selector");
    expect(sel?.source).toBe("(lambda (in0) (positive? in0))");
    expect(sel?.paramRefs[0]).toEqual({
      kind: "node",
      name: "in0",
      node: p.main.nodes.findIndex((n) => n.kind === "source"),
    });
    const arms = p.main.wires.filter((w) => w.consumer.node === muxIdx && w.consumer.slot.startsWith("arm"));
    expect(arms).toHaveLength(2);
  });

  it("coupling threads through a let binding (classify's subst — the inlined-form equality)", async () => {
    const p = await wf("(let ((y (src-a))) (if (positive? y) 1 2))");
    expect(kinds(p.main)).toContain("mux");
  });

  it("field-step selector: (:flag (src)) couples; (:flag cfg) over a plain slot collapses (walk()'s field-arm pattern)", async () => {
    const coupled = await wf("(if (:flag (src-a)) 1 2)");
    expect(kinds(coupled.main)).toContain("mux");

    const pure = await wf("(if (:flag cfg) 1 2)");
    expect(kinds(pure.main)).not.toContain("mux");
    expect(wireTo(pure.main, "out")?.params).toEqual(["cfg"]);
  });

  it("coupling is transitive through a port-reaching define (the reachClassifier's opaque lowering)", async () => {
    const p = await wf("(define (helper x) (src-a x))\n(if (helper k) 1 2)");
    expect(p.membership.wireframe.has("helper")).toBe(true);
    expect(kinds(p.main)).toContain("mux");
    // the selector wire cut the (helper k) call to a template-ref node
    expect(kinds(p.main)).toContain("template-ref");
  });

  it("a pure-selector mux WRAPPING a port stays a (lazy) mux — arms with cuts do not collapse (W-9)", async () => {
    // Selector (> x 0) is pure, but the arm holds a source: folding it into one wire would make
    // γ demand the (possibly unrecorded) port eagerly. Cut-free arms still collapse (above).
    const p = await wf("(if (> x 0) (src-a) y)");
    expect(kinds(p.main).sort()).toEqual(["mux", "port", "source"]);
    const sel = p.main.wires.find((w) => w.consumer.slot === "selector");
    expect(sel?.source).toBe("(lambda (x) (> x 0))");
    expect(p.main.wires.find((w) => w.consumer.slot === "arm0")?.source).toBe("(lambda (in0) in0)");
  });
});

describe("Q8a builder core — prelude, templates, template-refs (§1 A3/M1)", () => {
  it("a pure helper stays prelude-side and is referenced BY NAME from the wire body", async () => {
    const p = await wf("(define (inc n) (+ n 1))\n(emit! (inc x))");
    expect(p.prelude.names.has("inc")).toBe(true);
    const w = p.main.wires[0];
    expect(w.source).toBe("(lambda (x) (inc x))");
    expect(w.params).toEqual(["x"]); // inc is NOT ingress — a by-name reference
  });

  it("a port-reaching define becomes a TEMPLATE; its call site is a template-ref node wired like a port", async () => {
    const p = await wf("(define (fetch-price id) (fetch-item id))\n(+ (fetch-price x) 1)");
    expect(p.membership.wireframe.has("fetch-price")).toBe(true);
    const t = p.templates.get("fetch-price");
    expect(t).toBeDefined();
    expect(t?.params).toEqual(["id"]);
    expect(t?.graph.nodes.map((n) => n.kind).sort()).toEqual(["port", "source"]);
    // the template's source node receives `id` — the define's own formal, a slot
    const argWire = t?.graph.wires.find((w) => w.consumer.slot === "arg0");
    expect(argWire?.paramRefs).toEqual([{ kind: "slot", name: "id" }]);

    const refIdx = p.main.nodes.findIndex((n) => n.kind === "template-ref");
    expect(refIdx).toBeGreaterThanOrEqual(0);
    const call = p.main.nodes[refIdx];
    expect(call.kind === "template-ref" && call.name).toBe("fetch-price");
    expect(wireTo(p.main, "out")?.paramRefs).toEqual([{ kind: "node", name: "in0", node: refIdx }]);
  });

  it("a program of only defines has an empty main graph (egress null)", async () => {
    const p = await wf("(define (inc n) (+ n 1))");
    expect(p.main.nodes).toHaveLength(0);
    expect(p.main.egress).toBeNull();
  });
});

describe("Q8a builder core — fans are region hosts (§3 I5)", () => {
  it("a lambda callback's body becomes the region's PRIVATE template interior — its ports never enter G", async () => {
    const p = await wf("(length (map (lambda (v) (+ (fetch-item v) 1)) xs))");
    expect(kinds(p.main).sort()).toEqual(["fan", "port"]); // ONE node from G — no interior leak
    const fan = p.main.nodes.find((n) => n.kind === "fan");
    if (fan?.kind !== "fan") throw new Error("expected a fan node");
    expect(fan.lengthPreserving).toBe(true);
    expect(fan.elementParams).toEqual(["v"]);
    expect(fan.template).toBeDefined();
    expect(fan.template?.nodes.map((n) => n.kind).sort()).toEqual(["port", "source"]);
    // the fanned container arrives on the "source" slot
    const src = p.main.wires.find((w) => w.consumer.slot === "source");
    expect(src?.paramRefs).toEqual([{ kind: "slot", name: "xs" }]);
  });

  it("a template wire's slot beyond elementParams is a region CAPTURE by name (sealed ingress, I2)", async () => {
    const p = await wf("(length (map (lambda (v) (+ v scale)) xs))");
    const fan = p.main.nodes.find((n) => n.kind === "fan");
    if (fan?.kind !== "fan") throw new Error("expected a fan node");
    const egressWire = fan.template?.wires.find((w) => w.consumer.slot === "out");
    expect(egressWire?.params.toSorted()).toEqual(["scale", "v"]);
    // `scale` is a capture: a slot param, NOT an inlined value, NOT a G-node ref
    expect(egressWire?.paramRefs.every((r) => r.kind === "slot")).toBe(true);
  });

  it("filter is a length-CHANGING fan; a bare-symbol callback records fnOp with no template", async () => {
    const p = await wf("(length (filter positive? xs))");
    const fan = p.main.nodes.find((n) => n.kind === "fan");
    if (fan?.kind !== "fan") throw new Error("expected a fan node");
    expect(fan.lengthPreserving).toBe(false);
    expect(fan.fnOp).toBe("positive?");
    expect(fan.template).toBeUndefined();
  });
});

describe("Q8a′ builder core — loop-shaped binders get REAL backedge-wired interiors", () => {
  it("named let → binder{cycles} node with a real interior — no interior deferred", async () => {
    const p = await wf("(emit! (let loop ((i 0)) (if (> i 3) i (loop (+ i 1)))))");
    const binder = p.main.nodes.find((n) => n.kind === "binder");
    if (binder?.kind !== "binder") throw new Error("expected a binder node");
    expect(binder.cycles).toBe(true);
    expect(binder.op).toBe("named-let");
    expect(binder.params).toEqual(["i"]);
    // selector `(> i 3)` is pure → collapses (§1 A2, no mux node); the interior
    // holds exactly the backedge (`recur`, the `(loop (+ i 1))` arm) and the
    // terminal out-port (the `i` arm) — no half-wired/deferred placeholder.
    expect(binder.interior.nodes.map((n) => n.kind).sort()).toEqual(["port", "recur"]);
    expect(binder.interior.egress).not.toBeNull();
  });

  it("do → binder{cycles} node with a real interior — the step expression is the backedge", async () => {
    const p = await wf("(do ((i 0 (+ i 1))) ((> i 3) i))");
    const binder = p.main.nodes.find((n) => n.kind === "binder");
    if (binder?.kind !== "binder") throw new Error("expected a binder node");
    expect(binder.op).toBe("do");
    expect(binder.params).toEqual(["i"]);
    expect(binder.interior.nodes.map((n) => n.kind).sort()).toEqual(["port", "recur"]);
    expect(binder.interior.egress).not.toBeNull();
  });

  it("Q8a′: binder backedge wiring — loop interiors wireframe with per-iteration template referents", async () => {
    const p = await wf("(emit! (let loop ((i 0)) (if (> i 3) i (loop (+ i 1)))))");
    const binder = p.main.nodes.find((n) => n.kind === "binder");
    if (binder?.kind !== "binder") throw new Error("expected a binder node");

    // The binder's OWN ingress (in the ENCLOSING graph): the INITIAL value
    // only — the loop variable is NOT program ingress from G's point of view.
    const binderIdx = p.main.nodes.indexOf(binder);
    const initWire = p.main.wires.find((w) => w.consumer.node === binderIdx && w.consumer.slot === "arg0");
    expect(initWire?.source).toBe("(lambda () 0)");

    // Inside the interior: the recur node's arg0 is the NEXT-iteration value,
    // computed from the CURRENT iteration's `i` — the backedge, not a fresh
    // program ingress.
    const recurIdx = binder.interior.nodes.findIndex((n) => n.kind === "recur");
    expect(recurIdx).toBeGreaterThanOrEqual(0);
    const recurWire = binder.interior.wires.find((w) => w.consumer.node === recurIdx && w.consumer.slot === "arg0");
    expect(recurWire?.source).toBe("(lambda (i) (+ i 1))");
    expect(recurWire?.params).toEqual(["i"]);
  });

  it("Q8a′: a port inside a loop body is wireframed through the binder's interior graph", async () => {
    const p = await wf("(emit! (let loop ((i 0)) (if (> i 3) (fetch-item i) (loop (+ i 1)))))");
    const binder = p.main.nodes.find((n) => n.kind === "binder");
    if (binder?.kind !== "binder") throw new Error("expected a binder node");
    // The terminal arm's port lands as a designated node INSIDE the private
    // interior — never spliced into the enclosing graph `p.main` (I5's
    // discipline, extended to loop interiors).
    // (the pure `(> i 3)` selector's arm holds the source, so the `if` stays a lazy mux — W-9)
    expect(binder.interior.nodes.map((n) => n.kind).sort()).toEqual(["mux", "port", "recur", "source"]);
    expect(p.main.nodes.some((n) => n.kind === "source")).toBe(false);

    // A `do` loop's step position is equally wireframed — the step IS the
    // backedge's own ingress wire, so a source in step position lands there,
    // alongside `do`'s own `recur` node (the step-triggered backedge).
    const doProgram = await wf("(emit! (do ((i 0 (fetch-item i))) ((> i 3) i)))");
    const doBinder = doProgram.main.nodes.find((n) => n.kind === "binder");
    if (doBinder?.kind !== "binder") throw new Error("expected a binder node");
    expect(doBinder.interior.nodes.map((n) => n.kind).sort()).toEqual(["port", "recur", "source"]);
  });

  it("Q9 finding 4 (FLIPPED): do's result clause wires back through the recur node — the source lives in a STEP expression, not the result form itself", async () => {
    // `acc` never mentions `fetch-item` directly — the source only fires inside the
    // STEP expression that computes acc's next-iteration value. Before the fix, the
    // result clause's `acc` reference resolved to a plain per-iteration LEAF slot
    // (a "slot" paramRef, no node reference at all); the fix routes it through the
    // `recur` node's id instead, so reachability from the interior's egress now
    // walks into the step expression and finds the source.
    const p = await wf("(emit! (do ((i 0 (+ i 1)) (acc 0 (+ acc (fetch-item i)))) ((> i 3) acc)))");
    const binder = p.main.nodes.find((n) => n.kind === "binder");
    if (binder?.kind !== "binder") throw new Error("expected a binder node");
    expect(binder.op).toBe("do");
    const { interior } = binder;
    const recurIdx = interior.nodes.findIndex((n) => n.kind === "recur");
    expect(recurIdx).toBeGreaterThanOrEqual(0);
    const sourceIdx = interior.nodes.findIndex((n) => n.kind === "source");
    expect(sourceIdx).toBeGreaterThanOrEqual(0);

    // The egress ("out") wire — the result clause's own wire — carries a NODE
    // paramRef straight into the recur node (not a bare "acc" slot reference).
    expect(interior.egress).not.toBeNull();
    const egressWire = interior.wires.find((w) => w.consumer.node === interior.egress && w.consumer.slot === "out");
    expect(egressWire).toBeDefined();
    expect(egressWire?.paramRefs.some((r) => r.kind === "node" && r.node === recurIdx)).toBe(true);

    // And the derived reachability cone (Q8a′'s V4 walk) now includes the source
    // that only fires inside the step expression — the whole point of the fix.
    const reached = reachableNodes(interior, interior.egress as number);
    expect(reached.has(sourceIdx)).toBe(true);
  });

  it("Q8a′: V4 cone-traversal termination rows exercise over real backedge topology", async () => {
    const p = await wf("(emit! (let loop ((i 0)) (if (> i 3) i (loop (+ i 1)))))");
    const binder = p.main.nodes.find((n) => n.kind === "binder");
    if (binder?.kind !== "binder") throw new Error("expected a binder node");

    // A REAL loop interior — today a DAG, terminates trivially, but exercised
    // through the SAME guarded walk the synthetic case below stresses.
    const outIdx = binder.interior.egress;
    expect(outIdx).not.toBeNull();
    const reached = reachableNodes(binder.interior, outIdx as number);
    expect(reached.size).toBeGreaterThan(0);

    // A SYNTHETIC index-level cycle — two nodes whose wires reference each
    // other — the honest proof the guard is load-bearing: an UNGUARDED
    // version of this exact walk would never return on this input.
    const cyclic: WireframeGraph = {
      nodes: [
        { kind: "recur", span: "a" },
        { kind: "recur", span: "b" },
      ],
      wires: [
        {
          source: "(lambda (x) x)",
          params: ["x"],
          paramRefs: [{ kind: "node", name: "x", node: 1 }],
          span: "w0",
          consumer: { node: 0, slot: "arg0" },
        },
        {
          source: "(lambda (x) x)",
          params: ["x"],
          paramRefs: [{ kind: "node", name: "x", node: 0 }],
          span: "w1",
          consumer: { node: 1, slot: "arg0" },
        },
      ],
      egress: null,
    };
    expect(reachableNodes(cyclic, 0)).toEqual(new Set([0, 1]));
  });
});

describe("Q8a builder core — dropped top-level forms and program order (§1 D6)", () => {
  it("a non-final top-level form's ports still land; its pure residue emits no wire", async () => {
    const p = await wf("(emit! x)\n(+ y 1)");
    expect(kinds(p.main).sort()).toEqual(["port", "sink"]);
    // wires: the sink's arg wire + the egress wire — nothing for the dropped shell
    expect(p.main.wires).toHaveLength(2);
    expect(wireTo(p.main, "out")?.params).toEqual(["y"]);
  });
});

describe("Q8a — unevalWire's emission-time door (wire-locality)", () => {
  it("a port-reaching define used as a VALUE is a closure{ref:define} node (Q8a FLIPPED: no longer a door)", async () => {
    const p = await wf("(define (helper x) (src-a x))\n(emit! helper)");
    expect(kinds(p.main)).toEqual(["sink", "closure"]); // the sink is the last form: no egress port
    const closure = p.main.nodes[1];
    expect(closure).toMatchObject({
      kind: "closure",
      params: ["x"],
      captures: [],
      ref: { kind: "define", name: "helper" },
    });
    const arg = p.main.wires.find((w) => w.consumer.slot === "arg0");
    expect(arg?.source).toBe("(lambda (in0) in0)");
    expect(arg?.paramRefs).toEqual([{ kind: "node", name: "in0", node: 1 }]);
    expect(unboundSlots(p)).toEqual([]);
  });

  it("every emitted wire is CLOSED: re-parsing its source yields FV ⊆ prelude ∪ base (params lambda-bound)", async () => {
    const p = await wf(
      "(define (inc n) (+ n 1))\n(let ((y (src-a))) (if (positive? y) (inc y) (emit! (+ y (src-b)))))",
    );
    const graphs: WireframeGraph[] = [p.main, ...[...p.templates.values()].map((t) => t.graph)];
    for (const g of graphs) {
      for (const w of g.wires) {
        const [lam] = await parse(w.source);
        for (const name of freeVars(lam)) {
          expect(p.prelude.names.has(name) || isBaseName(name), `"${name}" leaked from ${w.source}`).toBe(true);
        }
      }
    }
  });
});

// PRE-H2 machinery fix wave — gap (2): `free-vars.ts` had no `case "try"` in its
// switch, so a `try`'s `(catch (var) …)` / `(finally …)` sub-clauses fell through
// the unmodeled-head default-arm application walk — their `catch`/`finally` marker
// heads leaked into the free-variable set (neither is bound anywhere; `try` itself
// only escaped by ALSO being a `KEYWORD_SYNTAX_BASELINE` entry). The fix adds a
// `case "try"` mirroring `static-validation/collect-references.ts`'s own "try" arm
// 1:1: the body walks in the outer scope, `catch`'s bound var scopes its handler
// body only, and the `catch`/`finally` markers themselves are structural literals,
// never free variables.
describe("Q8a — freeVars models `try` (evalTry's exact shape; mirrors collect-references.ts's arm)", () => {
  it("catch/finally marker heads never leak into the free-variable set", async () => {
    const [form] = await parse("(try (raise-continuable x) (catch (e) (handle e)) (finally (cleanup)))");
    const fv = freeVars(form);
    expect(fv.has("try")).toBe(false); // own head — excluded like every other special form
    expect(fv.has("catch")).toBe(false); // structural marker, not a variable
    expect(fv.has("finally")).toBe(false); // structural marker, not a variable
  });

  it("the catch variable binds for its own handler body only — never free, never leaked to `finally`", async () => {
    const [form] = await parse("(try (raise-continuable x) (catch (e) (handle e)) (finally (handle e)))");
    const fv = freeVars(form);
    // `e` inside `catch`'s own handler is BOUND (excluded); `e` inside `finally` is
    // a genuinely free reference (finally does NOT see the catch var) — both facts
    // collapse onto the SAME name here, so assert via the exact expected set instead.
    expect([...fv].sort()).toEqual(["e", "handle", "raise-continuable", "x"].sort());
  });

  it("the try body, catch handlers, and finally clause all contribute their OWN free variables", async () => {
    const [form] = await parse("(try (raise-continuable x) (catch (e) (handle e)) (finally (cleanup)))");
    const fv = freeVars(form);
    expect([...fv].sort()).toEqual(["cleanup", "handle", "raise-continuable", "x"].sort());
  });

  it("a `try` with only a body (no catch/finally clauses) still walks the body correctly", async () => {
    const [form] = await parse("(try (only-body-call x))");
    const fv = freeVars(form);
    expect([...fv].sort()).toEqual(["only-body-call", "x"].sort());
  });
});

// W-P1 — prelude membership soundness: a port NAMED anywhere in a define form makes it
// wireframe material, even where classify() (one expression, structurally) sees none.
describe("W-P1 — port-reaching defines are never prelude (name-scan witness beside classify)", () => {
  it.each([
    ["lambda RHS", "(define f (lambda (x) (src-a x)))\n(f 1)"],
    ["non-final body position", "(define (f x) (emit! x) (+ x 1))\n(f 1)"],
    ["lambda passed to a non-fan HOF", "(define (f xs) (for-each (lambda (x) (emit! x)) xs))\n(f (list 1))"],
  ])("%s → material, not prelude", async (_label, code) => {
    const p = await wf(code);
    const name = code.match(/\(define \(?(\w+)/)![1];
    expect(p.membership.wireframe.has(name)).toBe(true);
    expect(p.prelude.names.has(name)).toBe(false);
    expect(p.prelude.source).not.toContain("src-a");
    expect(p.prelude.source).not.toContain("emit!");
  });

  it("a dict-literal RHS naming a port is material (referencedSymbols descends {…})", async () => {
    const forms = await parse("(define cfg {:a (src-a 1)})");
    const m = classifyProgramPrelude(forms, C);
    expect(m.wireframe.has("cfg")).toBe(true);
  });

  it("a genuinely pure define stays prelude", async () => {
    const p = await wf("(define (inc n) (+ n 1))\n(inc 1)");
    expect(p.prelude.names.has("inc")).toBe(true);
  });
});

// W-P1b — referencedSymbols: dict literals are evaluated forms; quoted data is not.
describe("referencedSymbols — dict literals descended, quote skipped, quasiquote unquotes kept", () => {
  it('(let* ((a (ask "1")) (b {:x a})) (fetch b)) reaches `a` through the dict literal', async () => {
    const [form] = await parse('(let* ((a (ask "1")) (b {:x a})) (fetch b))');
    expect(referencedSymbols(form).has("a")).toBe(true);
    const [dict] = await parse("{:x a}");
    expect([...referencedSymbols(dict)]).toContain("a");
  });

  it("quoted data is not a reference", async () => {
    const [form] = await parse("(b (quote a))");
    expect(referencedSymbols(form).has("a")).toBe(false);
    expect(referencedSymbols(form).has("b")).toBe(true);
    const [tick] = await parse("(b 'a)");
    expect(referencedSymbols(tick).has("a")).toBe(false);
  });

  it("quasiquote: template symbols are data, unquoted parts are references", async () => {
    const [form] = await parse("`(a ,b (c ,@d))");
    const refs = referencedSymbols(form);
    expect(refs.has("a")).toBe(false);
    expect(refs.has("c")).toBe(false);
    expect(refs.has("b")).toBe(true);
    expect(refs.has("d")).toBe(true);
  });
});

// W-P2 — a material VALUE define is walked in main as a growing frame (not a zero-param template).
describe("W-P2 — value defines of port results", () => {
  it('(define plan (src-a 1)) (list plan "b") builds: source + port, egress wire over the source', async () => {
    const p = await wf('(define plan (src-a 1))\n(list plan "b")');
    expect(p.templates.has("plan")).toBe(false);
    expect(kinds(p.main).sort()).toEqual(["port", "source"]);
    const w = wireTo(p.main, "out")!;
    expect(w.paramRefs).toEqual([
      { kind: "node", name: "in0", node: p.main.nodes.findIndex((n) => n.kind === "source") },
    ]);
    expect(w.source).toBe('(lambda (in0) (let* ((plan in0)) (list plan "b")))');
  });

  it("unreached value defines are pruned from a wire (no over-attribution)", async () => {
    const p = await wf("(define plan (src-a 1))\n(define other (src-b 2))\n(list plan 3)");
    expect(kinds(p.main).filter((k) => k === "source")).toHaveLength(2);
    const w = wireTo(p.main, "out")!;
    expect(w.paramRefs).toHaveLength(1);
    expect(w.source).not.toContain("other");
  });

  it("a value define chain keeps transitive entries; a pure-RHS mixed define is a frame entry", async () => {
    const p = await wf("(define a (src-a 1))\n(define b (+ a 1))\n(emit! b)");
    const sink = p.main.nodes.findIndex((n) => n.kind === "sink");
    const w = p.main.wires.find((x) => x.consumer.node === sink)!;
    expect(w.source).toBe("(lambda (in0) (let* ((a in0) (b (+ a 1))) b))");
  });
});

// W-A1 — the bracket/curly surface is evaluated; the builder must see ports inside it.
describe("W-A1 — bracket bindings and [..]/{..} literals", () => {
  it("(let* ([a (src-a 1)] [b (+ a 1)]) (emit! b)) cuts the source", async () => {
    const p = await wf("(let* ([a (src-a 1)] [b (+ a 1)]) (emit! b))");
    expect(kinds(p.main).sort()).toEqual(["port", "sink", "source"]);
    const sink = p.main.nodes.findIndex((n) => n.kind === "sink");
    const w = p.main.wires.find((x) => x.consumer.node === sink)!;
    expect(w.source).not.toContain("src-a");
    expect(w.paramRefs.some((r) => r.kind === "node")).toBe(true);
  });

  it("whole-list bracket bindings (let [a (src-a 1)] …) and paren-list-of-bracket-entries", async () => {
    for (const code of ["(let [a (src-a 1)] (emit! a))", "(let ([a (src-a 1)]) (emit! a))"]) {
      const p = await wf(code);
      expect(kinds(p.main).sort(), code).toEqual(["port", "sink", "source"]);
    }
  });

  it("(emit! [1 (src-a 2)]) — the source inside a vector literal is cut", async () => {
    const p = await wf("(emit! [1 (src-a 2)])");
    expect(kinds(p.main).sort()).toEqual(["sink", "source"]);
    const sink = p.main.nodes.findIndex((n) => n.kind === "sink");
    expect(p.main.wires.find((x) => x.consumer.node === sink)!.source).toBe("(lambda (in0) [1 in0])");
  });

  it("(emit! {:a (src-a 2)}) — the source inside a dict literal is cut", async () => {
    const p = await wf("(emit! {:a (src-a 2)})");
    expect(kinds(p.main).sort()).toEqual(["sink", "source"]);
    const sink = p.main.nodes.findIndex((n) => n.kind === "sink");
    expect(p.main.wires.find((x) => x.consumer.node === sink)!.source).toBe("(lambda (in0) {:a in0})");
  });

  it("a free variable inside a literal is wire ingress (freeVars descends [..]/{..})", async () => {
    const p = await wf("(emit! [x {:k y}])");
    const sink = p.main.nodes.findIndex((n) => n.kind === "sink");
    expect(p.main.wires.find((w) => w.consumer.node === sink)!.params).toEqual(["x", "y"]);
  });

  it("(define cfg {:a (src-a 1)}) is material and its source lands in main", async () => {
    const p = await wf("(define cfg {:a (src-a 1)})\n(emit! (:a cfg))");
    expect(p.membership.wireframe.has("cfg")).toBe(true);
    expect(kinds(p.main).sort()).toEqual(["sink", "source"]);
  });

  it("bracket cond clauses and bracket do bindings/clauses are read", async () => {
    const c = await wf("(cond [(positive? (src-a 1)) (src-b 2)] [else 0])");
    expect(kinds(c.main)).toContain("mux");
    const d = await wf("(do ([i 0 (+ i 1)]) [(= i 2) i] (emit! i))");
    const binder = d.main.nodes.find((n) => n.kind === "binder");
    expect(binder?.kind === "binder" && binder.params).toEqual(["i"]);
  });

  it("selector reachability sees through bracket bindings (classify twin)", async () => {
    const p = await wf("(let ([y (src-a 1)]) (if (positive? y) 1 2))");
    expect(kinds(p.main)).toContain("mux");
  });
});

// W-A3 — `guard`: the clause var is bound in the clauses; ports in clauses and body land.
describe("W-A3 — guard", () => {
  it("(guard (e (#t (emit! e))) (src-a 1)) — a guard NODE: body wire, clause wires read the caught condition (W-A3 FLIPPED)", async () => {
    const p = await wf("(guard (e (#t (emit! e))) (src-a 1))");
    expect(kinds(p.main)).toEqual(["guard", "source", "sink", "port"]);
    expect(p.main.nodes[0]).toMatchObject({ kind: "guard", op: "guard", var: "e", clauses: 1, hasFinally: false });
    const into = (slot: string, node = 0) =>
      p.main.wires.find((w) => w.consumer.node === node && w.consumer.slot === slot)!;
    expect(into("body").source).toBe("(lambda (in0) (begin in0))");
    expect(into("selector0").source).toBe("(lambda (in0) (let ((e in0)) #t))");
    expect(into("selector0").paramRefs).toEqual([{ kind: "node", name: "in0", node: 0, slot: "condition" }]);
    expect(into("arm0").source).toBe("(lambda (in0 in1) (let ((e in0)) in1))");
    // the sink's own arg wire reads the caught condition too
    expect(into("arg0", 2).paramRefs).toEqual([{ kind: "node", name: "in0", node: 0, slot: "condition" }]);
    expect(p.main.wires.find((w) => w.consumer.slot === "out")?.source).toBe("(lambda (in0) in0)");
    expect(unboundSlots(p)).toEqual([]);
  });

  it("the clause var shadows an outer name inside the clause only", async () => {
    const [form] = await parse("(guard (e (#t e)) (f e))");
    expect([...freeVars(form)].sort()).toEqual(["e", "f"]); // body's `e` is the OUTER e
    const [form2] = await parse("(guard (e (#t (g e))) 1)");
    expect([...freeVars(form2)]).toEqual(["g"]);
  });
});

// W-7 — bare-name cuts are per OCCURRENCE (operand cell), not per interned symbol.
describe("W-7 — bare role names: one node per occurrence, real spans", () => {
  it('(list src-a src-a) → two closure{ref:port} nodes, spans from the parent form (never "?")', async () => {
    const p = await wf("(list src-a src-a)");
    const sources = p.main.nodes.filter((n) => n.kind === "closure" && n.ref?.kind === "port" && n.ref.op === "src-a");
    expect(sources).toHaveLength(2);
    for (const n of sources) expect(n.span).toMatch(/^list@/);
    const w = wireTo(p.main, "out")!;
    expect(w.source).toBe("(lambda (in0 in1) (list in0 in1))");
    expect(w.paramRefs.map((r) => (r.kind === "node" ? r.node : -1))).toEqual([0, 1]);
  });

  it("occurrences under different parents carry different spans", async () => {
    const p = await wf("(list (list src-a)\n(list src-a))");
    const sources = p.main.nodes.filter((n) => n.kind === "closure");
    expect(sources).toHaveLength(2);
    expect(new Set(sources.map((n) => n.span)).size).toBe(2);
  });

  it("a shadowing binder is not rewritten", async () => {
    const p = await wf("(list src-a (lambda (src-a) (list src-a)))");
    expect(p.main.nodes.filter((n) => n.kind === "closure")).toHaveLength(1);
    expect(wireTo(p.main, "out")!.source).toBe("(lambda (in0) (list in0 (lambda (src-a) (list src-a))))");
  });

  it("(emit! src-a) — the wire body IS the occurrence", async () => {
    const p = await wf("(emit! src-a)");
    const sink = p.main.nodes.findIndex((n) => n.kind === "sink");
    expect(p.main.wires.find((w) => w.consumer.node === sink)!.source).toBe("(lambda (in0) in0)");
  });
});

// W-A2 — `do` result clause: one param per loop var, each at its own recur slot.
describe("W-A2 — do result wire", () => {
  it('params map to DISTINCT recur slots; span is the do form\'s, never "?"', async () => {
    const p = await wf("(do ((i 0 (+ i 1)) (acc (list) (cons (src-a i) acc))) ((= i 2) (cons i acc)))");
    const binder = p.main.nodes.find((n) => n.kind === "binder");
    expect(binder?.kind).toBe("binder");
    if (binder?.kind !== "binder") return;
    const g = binder.interior;
    const out = g.wires.find((w) => w.consumer.slot === "out")!;
    const recur = g.nodes.findIndex((n) => n.kind === "recur");
    expect(out.paramRefs).toEqual([
      { kind: "node", name: "in0", node: recur, slot: "arg0" },
      { kind: "node", name: "in1", node: recur, slot: "arg1" },
    ]);
    expect(out.span).toMatch(/^do@/);
    expect(out.source).toBe("(lambda (in0 in1) (let ((i in0) (acc in1)) (cons i acc)))");
  });

  it("a bare-symbol result form takes the do form's span", async () => {
    const p = await wf("(do ((i 0 (+ i 1))) ((= i 2) i))");
    const binder = p.main.nodes.find((n) => n.kind === "binder");
    if (binder?.kind !== "binder") throw new Error("no binder");
    expect(binder.interior.wires.find((w) => w.consumer.slot === "out")!.span).toMatch(/^do@/);
  });
});

// W-6 — case / and / or with a port-reaching key/operand stay lazy muxes.
describe("W-6 — case/and/or are muxes when a selector reaches a port", () => {
  it("(case (src-a) ((1) (src-b)) (else 0)) → case mux: one selector per non-else clause, arm per clause", async () => {
    const p = await wf("(case (src-a) ((1) (src-b)) (else 0))");
    const mux = p.main.nodes.findIndex((n) => n.kind === "mux");
    expect(p.main.nodes[mux]).toMatchObject({ kind: "mux", op: "case", arms: 2 });
    const slots = p.main.wires
      .filter((w) => w.consumer.node === mux)
      .map((w) => w.consumer.slot)
      .sort();
    expect(slots).toEqual(["arm0", "arm1", "selector0"]);
    // the key's source is ONE node shared by the selector wire(s), not duplicated
    expect(kinds(p.main).filter((k) => k === "source")).toHaveLength(2); // src-a key + src-b arm
    expect(p.main.wires.find((w) => w.consumer.slot === "selector0")!.source).toBe(
      "(lambda (in0) (case in0 ((1) #t) (else #f)))",
    );
  });

  it("(and (positive? (src-a)) (src-b)) → and mux: selector = first operand, arm0 = the rest", async () => {
    const p = await wf("(and (positive? (src-a)) (src-b))");
    const mux = p.main.nodes.findIndex((n) => n.kind === "mux");
    expect(p.main.nodes[mux]).toMatchObject({ kind: "mux", op: "and", arms: 1 });
    expect(wireTo(p.main, "selector")?.source).toBe("(lambda (in0) (positive? in0))");
    expect(p.main.wires.find((w) => w.consumer.slot === "arm0")?.source).toBe("(lambda (in0) in0)");
  });

  it("(or a b c) with a port in b nests: the arm is itself an `or` mux over (b c)", async () => {
    const p = await wf("(or x (positive? (src-a)) (src-b))");
    const muxes = p.main.nodes.filter((n) => n.kind === "mux");
    expect(muxes).toHaveLength(2);
    expect(muxes.every((m) => m.kind === "mux" && m.op === "or")).toBe(true);
  });

  it("a port only in the LAST and/or operand does not force a mux (pure prefix)", async () => {
    // nothing earlier can reach a port; the item-9 rule (arms with cuts) governs the rest
    const p = await wf("(and (> x 0) y)");
    expect(kinds(p.main)).toEqual(["port"]);
  });
});
