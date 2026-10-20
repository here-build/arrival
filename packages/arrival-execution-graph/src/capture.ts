/**
 * L2 — retain the values of designated invocations while a run executes.
 *
 * The trace prunes a child's `.value` when its parent exits, so the operand values of a step
 * are gone the moment the step returns, and its own output is gone when ITS parent returns.
 * `ExecutionCapture` is the trace itself (pass it as `tap`): its `exit` reads a designated
 * invocation's operands BEFORE the base exit prunes them, and its output right after.
 *
 * Designation is by the resolved callee, not the head name: `(let ((g ask)) (g …))` is an
 * `ask` step, a local `ask` shadowing the designated one is not.
 *
 * Undesignated values the graph shows (a transformation's result) go the same way once their
 * spans are named with `retainSpans`: an invocation of such a form exiting AFTER the call keeps
 * its value — one exiting before is not retained.
 *
 * The base trace makes only ENTER observable; the last exit of a run would never tick. The
 * `revision` box here moves on every enter and every exit — react to it, not to `entries`.
 */

import { type EvalTrace as CoreEvalTrace, scopeId } from "@here.build/arrival/provenance";
import { EvalTrace, type Invocation } from "@here.build/arrival-provenance";
import { action, observable } from "mobx";

import { isPair, kindOf, operandForms, symbolName } from "./datum.js";

/** One argument of a designated call, in source order (the operand list after the head; for
 *  an `apply` host, the spread argument list). */
export interface CapturedOperand {
  /** The operand form as written; `undefined` for an element spread from `apply`'s list. */
  readonly form: unknown;
  /** `false` when the operand's value left no trace: a collection literal (evaluated without
   *  a tap), or an operand that has not been evaluated yet (live reads). */
  readonly hasValue: boolean;
  readonly value?: unknown;
}

export interface Captured {
  readonly inputs: readonly CapturedOperand[];
  readonly hasOutput: boolean;
  readonly output?: unknown;
  /** The rejection reason, when the invocation rejected. */
  readonly error?: unknown;
}

/**
 * The designated identity of a call invocation: the resolved callee's `__name__` (a program
 * lambda's define name) or `.name` (a rosetta / native procedure; an anonymous lambda reads
 * `"lambda"`), falling back to the head symbol's name when no resolution was recorded.
 * `undefined` for a call whose head is not a symbol (`((car fs) x)`).
 */
export function calleeName(trace: CoreEvalTrace, inv: Invocation): string | undefined {
  const head = symbolName((inv.node as { car?: unknown }).car);
  if (head !== undefined) {
    const callee = trace.symbolValues.get(inv)?.get(head);
    // Resolved: the procedure's own name is the identity. An anonymous lambda bound to a
    // designated name (`(let ((ask (lambda …))) (ask …))`) reads "lambda", not "ask".
    if (callee !== null && typeof callee === "object") return procedureName(callee);
  }
  return head;
}

function procedureName(proc: unknown): string | undefined {
  if (proc === null || typeof proc !== "object") return undefined;
  const named = (proc as { __name__?: unknown }).__name__ ?? (proc as { name?: unknown }).name;
  if (typeof named === "string") return named === "" ? undefined : named;
  if (typeof named === "symbol") return named.description;
  return undefined;
}

/** `(apply f …)` whose `f` resolved to a procedure: that procedure. */
function appliedProcedure(trace: CoreEvalTrace, inv: Invocation): unknown {
  if (calleeName(trace, inv) !== "apply") return undefined;
  const [f] = operandForms(inv.node);
  if (isPair(f)) return inv.children.find((c) => c.node === f)?.value;
  const name = symbolName(f);
  return name === undefined ? undefined : trace.symbolValues.get(inv)?.get(name);
}

/**
 * The designated identity of an invocation: {@link calleeName}, except that an `apply` host
 * is the procedure it applies (read before the host exits — a Pair `f` operand is pruned
 * after). Computed heads `((car fs) x)` stay unidentified.
 */
export function designatedName(trace: CoreEvalTrace, inv: Invocation): string | undefined {
  const name = calleeName(trace, inv);
  if (name !== "apply") return name;
  return procedureName(appliedProcedure(trace, inv)) ?? name;
}

/** Arguments of a call: its operands, or for an `apply` host the spread argument list
 *  (middle operands, then the elements of the last). Same validity rules as
 *  {@link readOperands}. */
export function readArguments(trace: CoreEvalTrace, inv: Invocation, pruned = false): CapturedOperand[] {
  const operands = readOperands(trace, inv, pruned);
  if (calleeName(trace, inv) !== "apply" || operands.length < 2) return operands;
  const spread = operands.slice(1, -1);
  const tail = operands.at(-1)!;
  if (!tail.hasValue) return [...spread, tail];
  for (let cur = tail.value; isPair(cur); cur = cur.cdr)
    spread.push({ form: undefined, hasValue: true, value: cur.car });
  return spread;
}

/**
 * Operand values of `inv` as they stand now. Pair operand → the child invocation entered for
 * that very form (identity, not span); symbol operand → the value it resolved to in `inv`;
 * any other datum is its own value. Pair operands are exact only while `inv`'s children are
 * unpruned — before `inv` exits; pass `pruned` for an exited invocation of a plain trace.
 */
export function readOperands(trace: CoreEvalTrace, inv: Invocation, pruned = false): CapturedOperand[] {
  return operandForms(inv.node).map((form): CapturedOperand => {
    if (isPair(form)) {
      const child = inv.children.find((c) => c.node === form);
      if (child?.state !== "resolved") return { form, hasValue: false };
      // Provenance points are exempt from the prune; every other child value is gone once
      // `inv` exited.
      if (pruned && !child.isProvenancePoint) return { form, hasValue: false };
      return { form, hasValue: true, value: child.value };
    }
    const name = symbolName(form);
    if (name !== undefined && !name.startsWith(":")) {
      const resolved = trace.symbolValues.get(inv);
      if (!resolved?.has(name)) return { form, hasValue: false };
      return { form, hasValue: true, value: resolved.get(name) };
    }
    // `[…]` / `{…}` literals lower to unlocated calls with no invocation: their value is not
    // observable, and the form itself is source, not a value.
    if (isCollectionLiteral(form)) return { form, hasValue: false };
    return { form, hasValue: true, value: form };
  });
}

function isCollectionLiteral(form: unknown): boolean {
  const kind = kindOf(form);
  if (kind === "vector") return (form as { evalElements?: unknown }).evalElements === true;
  if (kind === "dict") return Array.isArray((form as { literalForms?: unknown }).literalForms);
  return false;
}

export class ExecutionCapture extends EvalTrace {
  readonly symbols: ReadonlySet<string>;
  readonly #captured = new WeakMap<Invocation, Captured>();
  readonly #revision = observable.box(0);
  readonly #spans = new Set<string>();
  /** Retained-span invocation → its value; parent invocation → span → the last such child's. */
  readonly #values = new WeakMap<Invocation, unknown>();
  readonly #operands = new WeakMap<Invocation, Map<string, unknown>>();

  /** Moves on every enter and every exit. */
  get revision(): number {
    return this.#revision.get();
  }

  constructor(symbols: Iterable<string>, maxEntries?: number) {
    super(maxEntries);
    this.symbols = new Set(symbols);
    // Both seams are instance-field arrows (already action-wrapped `enter` from the base);
    // re-wrap so the revision write happens inside an action under `enforceActions`.
    const baseEnter = this.enter;
    this.enter = action((...args: Parameters<typeof baseEnter>) => {
      const inv = baseEnter(...args);
      this.#bump();
      return inv;
    });
    const baseExit = this.exit;
    this.exit = action((inv: Invocation, result: Parameters<typeof baseExit>[1]) => {
      const designated = this.isDesignated(inv);
      const inputs = designated ? readArguments(this, inv) : undefined;
      // The base exit's return carries the provenance-stamped clone the evaluator binds —
      // dropping it would change the program's own values.
      const ret = baseExit(inv, result);
      if (this.#spans.size > 0 && inv.state === "resolved") this.#retain(inv);
      if (inputs) {
        this.#captured.set(
          inv,
          inv.state === "rejected"
            ? { inputs, hasOutput: false, error: inv.error }
            : { inputs, hasOutput: true, output: inv.value },
        );
      }
      this.#bump();
      return ret;
    });
  }

  isDesignated(inv: Invocation): boolean {
    const name = designatedName(this, inv);
    return name !== undefined && this.symbols.has(name);
  }

  /** Values retained at exit; `undefined` for a running or undesignated invocation. */
  captured(inv: Invocation): Captured | undefined {
    return this.#captured.get(inv);
  }

  /** Keep the value of every invocation of these forms (`scopeId` spans) that exits from now
   *  on — values the trace would prune once the parent exits. */
  retainSpans(spans: Iterable<string>): void {
    for (const s of spans) this.#spans.add(s);
  }

  /** A retained invocation's value. */
  retainedValue(inv: Invocation): { value: unknown } | undefined {
    return this.#values.has(inv) ? { value: this.#values.get(inv) } : undefined;
  }

  /** The value of `parent`'s (last) child at `span`, when that span is retained. */
  retainedOperand(parent: Invocation, span: string): { value: unknown } | undefined {
    const m = this.#operands.get(parent);
    return m?.has(span) ? { value: m.get(span) } : undefined;
  }

  #retain(inv: Invocation): void {
    const span = scopeId(inv.node);
    if (!this.#spans.has(span)) return;
    this.#values.set(inv, inv.value);
    if (!inv.parent) return;
    const m = this.#operands.get(inv.parent) ?? new Map<string, unknown>();
    m.set(span, inv.value);
    this.#operands.set(inv.parent, m);
  }

  /** Operand values of a still-running invocation, read live (same rules as at exit). */
  liveInputs(inv: Invocation): CapturedOperand[] {
    return this.#captured.get(inv)?.inputs.slice() ?? readArguments(this, inv);
  }

  #bump(): void {
    this.#revision.set(this.#revision.get() + 1);
  }
}

export function createExecutionCapture(symbols: Iterable<string>, maxEntries?: number): ExecutionCapture {
  return new ExecutionCapture(symbols, maxEntries);
}
