/**
 * Wireframe structural validator — the closure-nodes invariant (P17): every slot param of every
 * wire is BOUND at the level that reads it.
 *
 *   main                : slot params ⊆ `declaredIngress` (default ∅ — a closed program)
 *   define template     : slot params ⊆ template.params
 *   closure.template    : slot params ⊆ params ∪ {rest} ∪ captures
 *   fan.template        : slot params ⊆ elementParams ∪ captures
 *   binder.interior     : slot params ⊆ binder.params ∪ captures
 *
 * and the capture/guard wiring is complete: every declared capture has EXACTLY ONE
 * `capture:<name>` wire in the enclosing graph (and no stray ones); a guard has exactly one
 * `body` wire and the `selector{k}`/`arm{k}` wires its clause count implies.
 *
 * Findings, not throws: a law asserts `unboundSlots(program)` is empty.
 */
import type { WireframeGraph, WireframeNode, WireframeProgram } from "./types.js";

export interface UnboundSlot {
  /** Path of the graph the finding sits in (`main`, `template:f`, `main/#3:closure`, …). */
  readonly graph: string;
  /** Index of the offending wire in that graph's `wires` (-1 for a node-level wiring finding). */
  readonly wire: number;
  /** The unbound slot name, or a `capture:<name>` / `body` / `selector{k}` / `arm{k}` wiring finding. */
  readonly name: string;
}

export interface UnboundSlotsOptions {
  /** Main-program ingress names the run's environment legitimately binds. Default ∅. */
  readonly declaredIngress?: ReadonlySet<string>;
}

/** The interior graph a node owns, with the names that bind it, or undefined. */
function interiorOf(
  node: WireframeNode,
): { graph: WireframeGraph; bound: readonly string[]; captures: readonly string[] } | undefined {
  switch (node.kind) {
    case "closure":
      return node.template === undefined
        ? undefined
        : {
            graph: node.template,
            bound: [...node.params, ...(node.rest === undefined ? [] : [node.rest]), ...node.captures],
            captures: node.captures,
          };
    case "fan":
      return node.template === undefined
        ? undefined
        : { graph: node.template, bound: [...(node.elementParams ?? []), ...node.captures], captures: node.captures };
    case "binder":
      return { graph: node.interior, bound: [...node.params, ...node.captures], captures: node.captures };
    default:
      return undefined;
  }
}

export function unboundSlots(program: WireframeProgram, opts: UnboundSlotsOptions = {}): UnboundSlot[] {
  const out: UnboundSlot[] = [];

  const check = (graph: WireframeGraph, path: string, bound: ReadonlySet<string>): void => {
    graph.wires.forEach((w, wi) => {
      for (const ref of w.paramRefs) {
        if (ref.kind === "slot" && !bound.has(ref.name)) out.push({ graph: path, wire: wi, name: ref.name });
      }
    });
    graph.nodes.forEach((node, ni) => {
      const here = `${path}/#${ni}:${node.kind}`;
      const into = graph.wires.filter((w) => w.consumer.node === ni);
      const interior = interiorOf(node);
      if (interior !== undefined) {
        // Capture wiring: exactly one `capture:<name>` wire per declared capture, none stray.
        const declared = new Set(interior.captures);
        for (const name of declared) {
          const n = into.filter((w) => w.consumer.slot === `capture:${name}`).length;
          if (n !== 1) out.push({ graph: here, wire: -1, name: `capture:${name}` });
        }
        for (const w of into) {
          if (w.consumer.slot.startsWith("capture:") && !declared.has(w.consumer.slot.slice("capture:".length))) {
            out.push({ graph: here, wire: -1, name: w.consumer.slot });
          }
        }
        check(interior.graph, here, new Set(interior.bound));
      }
      if (node.kind === "guard") {
        if (into.filter((w) => w.consumer.slot === "body").length !== 1)
          out.push({ graph: here, wire: -1, name: "body" });
        for (let k = 0; k < node.clauses; k++) {
          if (into.filter((w) => w.consumer.slot === `arm${k}`).length !== 1) {
            out.push({ graph: here, wire: -1, name: `arm${k}` });
          }
        }
      }
    });
  };

  check(program.main, "main", opts.declaredIngress ?? new Set());
  for (const [name, t] of program.templates) check(t.graph, `template:${name}`, new Set(t.params));
  return out;
}
