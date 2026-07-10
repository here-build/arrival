// uneval.ts — the `{result, meta, uneval}` container + the selector-eval step.
//
// By design (no new entity): a traced run yields a container whose `uneval` is NOT special
// trickery — `uneval("(car result)")` evaluates the selector as ONE MORE tapped step (with the
// program's output bound to `result`, so the effective value carries provenance intact), then
// reverse-slices the trace by that effective value's provenance into a re-runnable Scheme program
// that re-derives exactly it.
//
// Why this is sound (and why arrival was made pure): the language is pure dataflow with on-value
// provenance, so the effective value's origin set IS its dependency set, and a program restricted
// to that derivation reproduces the value (the Galois-slicing `uneval` of Perera–Cheney; purity is
// the theorem that makes the least slice exist and be sound). The container's `program` is the
// real SLICE (via `buildSlice`): only the top-level forms the effective value depends on, plus
// the selector. Intra-form minimal slicing (sub-form re-synthesis) is the deferred increment.

import { execExpr, parse } from "../eval/generator-exec.js";
import { AValue } from "../values/primitives/AValue.js";
import { schemeToJs } from "../rosetta.js";
import { WireLocalityError } from "../errors.js";
import type { SchemeEnv } from "../common/scheme-env.js";
import type { SchemeValue } from "../values/types.js";

import { buildSlice, writeForm, writeFormWith, defineNameOf, lastTopLevelForm } from "./slice.js";
import { scopeId } from "./scope-id.js";
import { freeVars } from "./wireframe/free-vars.js";
import type { EmittedWire, WireFrame, WireParam } from "./wireframe/types.js";
import type { EvalTrace } from "./trace.js";

/** One reverse-chain answer: the effective value the selector produced, the origin reads it
 *  traces to, and a re-runnable Scheme program that re-derives it. */
export interface Uneval {
  /** The effective value the selector picked out (peeled to plain JS). */
  value: unknown;
  /** The origin-IDs the value traces to — the provenance-point invocations (the evidence reads /
   *  marked derivations). Empty if the selector produced a non-provenanced value. */
  provenance: number[];
  /** A re-runnable Scheme program re-deriving the value: the SLICE — only the top-level forms the
   *  effective value depends on (the backward dependence cone), followed by the selector that
   *  picks it out. Unrelated forms are pruned; referenced literal defines are kept. */
  program: string;
  /** The dynamic point-cone — the provenance-point ids the value depends on (the evidence reads
   *  / derivations). The per-leaf→read join key; also a UI source-highlight seed. */
  points: number[];
  /** `scopeId` of each kept form (stable source-location keys, for UI highlighting). */
  scopeIds: string[];
}

/** A traced run's return value, by design: the answer, run metadata, and `uneval`. */
export interface UnevalContainer {
  /** The program's output value (peeled to plain JS). */
  result: unknown;
  meta: { forms: number };
  /** Evaluate a selector ("(car result)", "(:PID (car result))") as one more tapped step and
   *  reverse-slice the trace by the effective value's provenance. */
  uneval: (selector: string) => Promise<Uneval>;
}

/** Build the `{result, meta, uneval}` container from a finished traced run. `result` is the run's
 *  final value as a raw AValue (provenance intact — NOT schemeToJs-peeled); `env` is the post-run
 *  scope (so the selector evaluates with `result` bound); `trace` is the run's EvalTrace (so the
 *  selector's step records, and the slice can read the whole lineage). `source` is the original
 *  program text (the v1 program render). */
export function buildUneval(opts: {
  // The post-run scope a selector re-evaluates in. Typed `SchemeEnv` — the public structural
  // contract (never the package-internal `Environment` class), and (V2, arrival-environment-
  // privatization.md §II.3/D2) the same type `ExecOptions.env` now takes, so this passes straight
  // through to `execExpr(lastForm, { env, tap: trace })` below with no narrowing at the call site.
  // Every real caller already holds a base-linked env satisfying this (arrival-run's
  // `buildArrivalEnv` / `sandboxedEnv.inherit(...)`, the README's own "run it backward" example).
  env: SchemeEnv;
  result: unknown;
  trace: EvalTrace;
  source: string;
  forms: readonly unknown[];
}): UnevalContainer {
  const { env, result, trace, forms } = opts;
  // The run's OUTPUT expression (the last top-level form) is what produces `result`. The slice is
  // anchored on the symbols IT references, so the derivation of `result` is reproduced in full;
  // we then bind `result` to it and append the selector — the selector picks the effective value
  // out of the reproduced output. Anchoring on the output form (not the value's provenance cone)
  // is what makes the slice CLOSED: its binding form + whole consumer chain are kept by reference.
  // The run's OUTPUT form — explicit `forms` if threaded, else the trace's last top-level form
  // (captured HERE, before any selector eval pollutes the trace with its own top-level form).
  const outputForm = forms.length > 0 ? forms.at(-1) : lastTopLevelForm(trace);
  const outputName = outputForm === undefined ? null : defineNameOf(outputForm);
  // `result` re-expressed in the slice's terms: the output's name if it's a define, else the
  // output expression rendered back to source.
  const resultExpr = outputForm === undefined ? "result" : (outputName ?? writeForm(outputForm));

  return {
    // `result`/`v` (below) are declared `unknown` at this public boundary (this file's own
    // `env.set("result", result as never)` already casts the same value to bind it into the
    // interpreter's env — it must genuinely be a SchemeValue to be usable there), so the
    // schemeToJs cast here documents the same pre-existing contract rather than widening
    // schemeToJs's own honest input bound.
    result: schemeToJs(result as SchemeValue | undefined, {}),
    meta: { forms: forms.length },
    uneval: async (selector: string): Promise<Uneval> => {
      // Bind the run's output as `result`, then evaluate the selector as ONE more tapped step —
      // the effective value is produced by the SAME pure evaluator, so it carries provenance and
      // becomes a trace node, exactly like any value the program itself computed.
      env.set("result", result as never);
      const sel = await parse(selector);
      const lastForm = sel.at(-1);
      if (lastForm === undefined) throw new Error(`uneval: selector "${selector}" parsed to zero forms`);
      let v: unknown = await execExpr(lastForm, { env, tap: trace });
      if (v != null && typeof (v as { then?: unknown }).then === "function") v = await (v as Promise<unknown>);
      const provenance = v instanceof AValue ? [...v.provenance] : [];
      // The SLICE: the reachable derivation of the run's output (static backward reference-closure
      // from the output's symbols), then a LET that binds `result` to the reproduced output and
      // evaluates the selector against it. A `let` (not a top-level `(define result …)`) avoids a
      // collision when the program's own output binding is itself named `result` (which produced a
      // degenerate `(define result result)`). Closed + re-runnable by construction.
      const slice = buildSlice(trace, outputForm);
      const tail = `(let ((result ${resultExpr})) ${selector.trim()})`;
      const program = slice.program ? `${slice.program}\n${tail}` : tail;
      // `v` is the tapped step's result — same evaluator-output contract as `result` above.
      return {
        value: schemeToJs(v as SchemeValue | undefined, {}),
        provenance,
        program,
        points: slice.points,
        scopeIds: slice.scopeIds,
      };
    },
  };
}

// ---------------------------------------------------------------------------------
// THE WIRE-EMISSION half of uneval: a wire is a closed arrival lambda. `uneval` emits
// it lambda-lifted — parameters = ingress, FV(body) ⊆ params ∪ prelude-names, checked
// AT EMISSION (the wire-locality law).
//
// Where `buildUneval` above reverse-slices a FINISHED trace (retrospective), this
// half materializes the PROSPECTIVE layer's edges: the wireframe builder hands over
// a surface expression, the `let`-frames it sat under, and the designated subterms
// it CUT to nodes; `unevalWire` closes the residue into `(lambda (p…) body)` —
// pure data, serializable, content-addressable (hashed by the wireframe hasher),
// applied by γ.
// ---------------------------------------------------------------------------------

/** What the wireframe builder hands `unevalWire` per wire. */
export interface WireEmission {
  /** The wire body's surface form (reader Pairs; spans intact). */
  readonly expr: unknown;
  /** Enclosing `let`-family frames, OUTERMOST first — re-wrapped verbatim around the
   *  body so binding structure (incl. parallel-`let` scoping) survives lambda-lifting.
   *  Verbatim wrapping is sound (purity: γ recomputes); minimal pruning is a later
   *  refinement — granularity is the accepted phrasing-sensitivity LIMIT. */
  readonly frames: readonly WireFrame[];
  /** Designated subterms CUT out of wire space: surface pair → wireframe node id.
   *  Each occurrence in `expr`/frames becomes a minted param wired to that node. */
  readonly cuts: ReadonlyMap<unknown, number>;
  /** PURE program-prelude define names (the prelude-membership partition) — referenced BY NAME. */
  readonly preludeNames: ReadonlySet<string>;
  /** Port-reaching define names — must NEVER survive into a wire body as a free
   *  value reference: name indirection would smuggle sources. */
  readonly materialNames: ReadonlySet<string>;
  /** Is this name resolvable in the hermetic BASE env (natives, macros, base packs)?
   *  Base references stay by-name — the hermetic assembler provides them. */
  readonly isBaseName: (name: string) => boolean;
}

/** Every interned symbol name occurring anywhere under `n` (descends everything,
 *  including quoted data — collision avoidance wants the COARSEST view). */
function allSymbolNames(n: unknown, into: Set<string>, seen: Set<unknown>): void {
  if (n === null || typeof n !== "object" || seen.has(n)) return;
  seen.add(n);
  const kind = (n as { kind?: string }).kind;
  if (kind === "symbol") {
    const name = (n as { __name__: string | symbol }).__name__;
    if (typeof name === "string") into.add(name);
    return;
  }
  if (kind === "pair") {
    allSymbolNames((n as { car: unknown }).car, into, seen);
    allSymbolNames((n as { cdr: unknown }).cdr, into, seen);
    return;
  }
  if (kind === "vector") for (const el of (n as { __vector__: unknown[] }).__vector__) allSymbolNames(el, into, seen);
}

/** Cut pairs occurring in the wire's body space (frames' RHSs then the body expr),
 *  in deterministic first-encounter order; never descends INTO a cut. */
function collectCuts(e: WireEmission): unknown[] {
  const found: unknown[] = [];
  const seen = new Set<unknown>();
  const walk = (n: unknown): void => {
    if (n === null || typeof n !== "object" || seen.has(n)) return;
    seen.add(n);
    if (e.cuts.has(n)) {
      found.push(n);
      return; // the cut's interior belongs to the node's own wires
    }
    const kind = (n as { kind?: string }).kind;
    if (kind === "pair") {
      walk((n as { car: unknown }).car);
      walk((n as { cdr: unknown }).cdr);
    } else if (kind === "vector") {
      for (const el of (n as { __vector__: unknown[] }).__vector__) walk(el);
    }
  };
  for (const frame of e.frames) for (const entry of frame.entries) walk(entry.rhs);
  walk(e.expr);
  return found;
}

/** FV of the FRAMED body — `freeVars` of the expr composed backwards through the
 *  frames per each frame kind's scoping rule (let: parallel; let*: sequential;
 *  letrec/letrec*: recursive). Cuts contribute nothing (they become params). */
function framedFreeVars(e: WireEmission): Set<string> {
  const opts = { cuts: e.cuts };
  let fv = freeVars(e.expr, opts);
  for (let i = e.frames.length - 1; i >= 0; i--) {
    const frame = e.frames[i];
    const names = frame.entries.map((en) => en.name);
    if (frame.kind === "let") {
      const next = new Set<string>([...fv].filter((n) => !names.includes(n)));
      for (const en of frame.entries) for (const n of freeVars(en.rhs, opts)) next.add(n);
      fv = next;
    } else if (frame.kind === "let*") {
      for (let j = frame.entries.length - 1; j >= 0; j--) {
        fv.delete(frame.entries[j].name);
        for (const n of freeVars(frame.entries[j].rhs, opts)) fv.add(n);
      }
    } else {
      // letrec / letrec*: all names bind everywhere (inits included).
      for (const en of frame.entries) for (const n of freeVars(en.rhs, opts)) fv.add(n);
      fv = new Set<string>([...fv].filter((n) => !names.includes(n)));
    }
  }
  return fv;
}

/**
 * Emit ONE closed wire lambda — THE wire-locality enforcement point: checked AT
 * EMISSION, never a post-hoc audit; a wire that would violate locality is
 * unrepresentable because this door refuses to mint it.
 *
 * - Free variables resolve, in teaching order: port-reaching define → the
 *   `WireLocalityError` door (it must be a `template-ref` NODE — as a first-class
 *   value it would smuggle its ports past γ's frozen-payload rule); pure prelude
 *   name → stays by-name (captures that resolve to prelude or native names are
 *   REFERENCES, never payloads); hermetic-base name → by-name; anything else →
 *   an ingress SLOT param (env-supplied at run/replay).
 * - Cut designated subterms become minted `inN` params (collision-checked against
 *   every symbol in body space), each carrying its node id in `paramRefs`.
 * - The body re-wraps its `let` frames verbatim, so the emitted lambda equals the
 *   original phrasing with ports excised — `parse`-able Pairs-with-spans, the
 *   tagless algebra under evaluation, never a JS closure.
 */
export function unevalWire(e: WireEmission): EmittedWire {
  const span = scopeId(e.expr);

  // 1 — ingress partition of the framed body's free variables.
  const slots: string[] = [];
  for (const name of framedFreeVars(e)) {
    if (e.materialNames.has(name)) {
      throw new WireLocalityError(
        name,
        span,
        `"${name}" is a port-reaching top-level define (wireframe material) — a wire may only ` +
          `reference it as a CALL (which cuts to a template-ref node), never capture it as a value; ` +
          `carrying it by name would let γ re-invoke its ports on replay`,
      );
    }
    if (e.preludeNames.has(name)) continue; // pure prelude — reference BY NAME
    if (e.isBaseName(name)) continue; // hermetic base (native/macro/pack) — by name
    slots.push(name); // program/template ingress — the run env binds it
  }

  // 2 — mint collision-free params for the cut node egresses.
  const cutPairs = collectCuts(e);
  const used = new Set<string>(slots);
  {
    const seen = new Set<unknown>();
    for (const frame of e.frames) for (const entry of frame.entries) allSymbolNames(entry.rhs, used, seen);
    allSymbolNames(e.expr, used, seen);
  }
  const cutNames = new Map<unknown, string>();
  const cutRefs: WireParam[] = [];
  let mint = 0;
  for (const pair of cutPairs) {
    let name = `in${mint++}`;
    while (used.has(name) || e.isBaseName(name) || e.preludeNames.has(name)) name = `in${mint++}`;
    used.add(name);
    cutNames.set(pair, name);
    const node = e.cuts.get(pair);
    if (node === undefined) throw new WireLocalityError(name, span, "internal: collected cut has no node id");
    cutRefs.push({ kind: "node", name, node });
  }

  // 3 — serialize: body with cut substitution, re-wrapped in its frames, closed.
  const sub = (n: unknown): string | undefined => cutNames.get(n);
  let body = writeFormWith(e.expr, sub);
  for (let i = e.frames.length - 1; i >= 0; i--) {
    const frame = e.frames[i];
    const binds = frame.entries.map((en) => `(${en.name} ${writeFormWith(en.rhs, sub)})`).join(" ");
    body = `(${frame.kind} (${binds}) ${body})`;
  }

  const paramRefs: WireParam[] = [...slots.map((name): WireParam => ({ kind: "slot", name })), ...cutRefs];
  const params: string[] = paramRefs.map((r) => r.name);
  return { source: `(lambda (${params.join(" ")}) ${body})`, params, paramRefs, span };
}
