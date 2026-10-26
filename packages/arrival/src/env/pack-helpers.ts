// Shared env-layer helpers for capability packs.
//
// Pack isolation (docs/environments.md §CAPABILITY: a capability reaches another only
// through a declared `deps` edge, never sideways into its internals) forbids a PACK
// importing another PACK — it does NOT forbid packs sharing a non-pack env-layer
// module, exactly as they all share `common/capability.ts` and
// `values/op-helpers.ts`. This module is that shared door: a helper several packs
// need (e.g. `to_array`, used by r7rs/lists, r7rs/vectors, srfi/srfi-13) lives here
// ONCE — the fix for a cross-pack need is this module, not per-pack duplication.

import invariant from "tiny-invariant";
import { resolveMethod } from "../common/symbols/_bake.js";
import { notImplemented } from "../common/symbols/notImplemented.js";
import { attachOffendingValue, R7RSError } from "../errors.js";
import { toIndex } from "../values/op-helpers.js";
import { tf, type TaglessOp } from "../values/tagless-final.js";
import { APair, isCircularList } from "../values/primitives/APair.js";
import { ANil } from "../values/primitives/ANil.js";
import { AVector } from "../values/primitives/AVector.js";
import { AJSArray } from "../membrane/AJSArray.js";
import { adoptSpine } from "../membrane/adopt-spine.js";
import type { SchemeValue } from "../values/types.js";
import type { AValue } from "../values/primitives/AValue.js";
import type { EmitCtx } from "../emit/emit-rule.js";
import type { Binding, R } from "../emit/residual-lite.js";

/** The member-protocol face of a scheme value. R7RSError is the one SchemeValue
 *  outside AValue; it declares no member terms, so it reads as term-less. */
export function asReceiver(value: SchemeValue): AValue | null {
  return value instanceof R7RSError ? null : value;
}

function describeTail(node: unknown): string {
  try {
    return String(node);
  } catch {
    return typeof node;
  }
}

/** Reject circular/improper lists (the iterator folds tails). */
export function to_array(name: string): (list: SchemeValue) => SchemeValue[] {
  return function (input: SchemeValue): SchemeValue[] {
    // Polyglot by observation: a host array / vector handed where a list is read is
    // the same sequence (Clojure `apply` takes any seq). Adopt the spine view here —
    // the same O(1) path z.listAlike slots use — so every to_array consumer agrees.
    const list = adoptSpine(input);
    if (list instanceof ANil) {
      return [];
    }
    // Wide `SchemeValue` param: isCircularList only accepts a Pair, so narrow here;
    // a non-Pair non-Nil reaches the loop's own improper-list door below.
    invariant(!(list instanceof APair && isCircularList(list)), `${name}: can't convert a circular list`);
    const result: SchemeValue[] = [];
    let node: unknown = list;
    while (true) {
      if (node instanceof APair) {
        if (node.have_cycles("cdr")) {
          break;
        }
        result.push(node.car);
        node = node.cdr;
      } else {
        if (!(node instanceof ANil)) {
          throw attachOffendingValue(
            new TypeError(
              node instanceof AVector || node instanceof AJSArray
                ? `${name}: can't convert improper list — its tail is a vector-like; use (vector->list v) to turn it into a list first`
                : `${name}: can't convert improper list — it ends in ${describeTail(node)} instead of '(); end it with '() or build it with (list …)`,
            ),
            node,
          );
        }
        break;
      }
    }
    return result;
  };
}

/** AValue's declared signature for the tagless-final term `op`. */
type TermOf<K extends TaglessOp> = NonNullable<AValue[`arrival/tagless-final/${K}`]>;

/** The tagless-final term method `op` on `value`, or a teaching door when the operand
 *  carries no such algebra (TOTALIC: a missing term is a type error, never a silent
 *  coercion). One home for the "operand does not support X" door. */
export function requireTerm<K extends TaglessOp>(value: unknown, op: K): TermOf<K> {
  const m = resolveMethod(value, tf(op));
  if (m === undefined) {
    throw attachOffendingValue(
      new TypeError(
        `${op}: the ${value == null ? String(value) : typeof value} operand does not support ${op} (no ${tf(op)}).`,
      ),
      value,
    );
  }
  // resolveMethod only checks that the key holds a function; AValue declares its signature.
  return m as TermOf<K>;
}

/** Resolve an optional `[start, end)` pair against a sequence of `len` elements.
 *  Out-of-range is a taught error, never JS `slice` semantics (negative = from the
 *  end, past-the-end = clamp) — `(vector-copy #(1 2 3) -2)` must not answer `#(2 3)`. */
export function sliceRange(
  name: string,
  len: number,
  start: unknown,
  end: unknown,
  what = "sequence",
): { readonly start: number; readonly end: number } {
  const s = start === undefined ? 0 : toIndex(start);
  const e = end === undefined ? len : toIndex(end);
  if (!Number.isInteger(s) || !Number.isInteger(e) || s < 0 || e > len || s > e) {
    throw new RangeError(
      `${name}: range [${s}, ${e}) out of range for a ${what} of length ${len} (need 0 <= start <= end <= ${len})`,
    );
  }
  return { start: s, end: e };
}

/** One `symbol.notImplemented` purity door per `[name, reason]` entry. */
export function doorSymbols(
  doors: Readonly<Record<string, string>>,
): Record<string, ReturnType<typeof notImplemented>> {
  return Object.fromEntries(Object.entries(doors).map(([name, reason]) => [name, notImplemented`${name}: ${reason}`]));
}

// ── Emit-rule helpers (shared by the lists / numeric / equality / srfi-1 rules) ──

/** Fixed-arity refusal: wrong arity is a static defect → `ctx.door`, not a walker
 *  crash on `undefined`. */
export function exactly<T>(ctx: EmitCtx<R>, sym: string, args: readonly T[], n: number): readonly T[] {
  if (args.length !== n) ctx.door(`\`${sym}\` wants exactly ${n} argument${n === 1 ? "" : "s"}, got ${args.length}`);
  return args;
}

/** `EmitCtx.fresh` is typed `unknown` in arrival core (residual algebra stays in the
 *  compiler package); cast once to Binding — no rule touches `fresh` raw. */
export function freshBinding(ctx: EmitCtx<R>, hint: string): Binding {
  return ctx.fresh(hint) as Binding;
}

/** Argument fact proves an array representation (list / pair / non-empty list). */
export const provesArray = (f: { list?: true; pair?: true; nonEmptyList?: true } | undefined): boolean =>
  f?.list === true || f?.pair === true || f?.nonEmptyList === true;
