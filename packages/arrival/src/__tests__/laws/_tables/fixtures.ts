/**
 * F1 shared minting kit (docs/test-suite-v2/DESIGN.md §F1).
 *
 * Every law cell needs a 3-element carrier whose elements are individually
 * provenance-stamped, so the term's box discipline is observable. This module is
 * the ONE place that mints, mirroring the mechanism golden-prov-infer.test.ts /
 * lineage-assumptions.test.ts already established (`env.defineRosetta` registering
 * a deterministic Rosetta-IN source whose fn returns an ALREADY-STAMPED value —
 * `jsToScheme`'s "same-provenance fast path" then passes it through unchanged,
 * see rosetta.ts's `createRosettaWrapper`: with no tap installed, `resultProvenance`
 * falls back to `inputProvenance`, which is EMPTY for a literal arg, so
 * `jsToScheme` sees `provenance === EMPTY_PROVENANCE` and returns our stamped
 * value AS-IS instead of re-stamping it empty).
 *
 * Unlike golden-prov-infer's FIXED mint ids (a deterministic golden capture), `src`
 * here mints a FRESH id per call (P11 — mint at the edge, one point per crossing),
 * so a 3-argument mint3 snippet produces three DISTINCT ids in call order —
 * exactly what the F1 grid's conservation/box-discipline checks need to track.
 */
import { freshEnv } from "../../_fresh-env.js";
import { execState } from "../../../eval/generator-exec.js";
import { fromJS } from "../../../membrane.js";
import { AValue } from "../../../values/primitives/AValue.js";
import { APair } from "../../../values/primitives/APair.js";
import { AVector } from "../../../values/primitives/AVector.js";
import { AJSArray } from "../../../values/primitives/AJSArray.js";
import { ADict } from "../../../values/primitives/ADict.js";
import { collapseProvenance } from "../../../provenance-collapse.js";
import * as z from "../../../common/scheme-zod.js";
import type { Environment } from "../../../Environment.js";
import type { SchemeValue } from "../../../values/types.js";
import type { CarrierRow } from "./carriers.js";

/**
 * Box a raw JS leaf — or (the only path `src` actually takes, see below) an
 * already-boxed AValue — with a FRESH single-id provenance set. One point minted
 * per `src` call (P11), regardless of the carrier's element type (numbers for the
 * numeric carriers, characters for AString). The number/string/boolean arms are a
 * defensive fallback, not a live path: `src` is bound bare (not a rosetta), so its
 * arg always arrives still-boxed — see `withLawEnv`'s doc for why that's load-bearing.
 */
function stampFresh(raw: unknown, id: number): AValue {
  if (raw instanceof AValue) return raw.withProvenance(new Set([id])) as AValue;
  if (typeof raw === "number") return z.number.encode(raw).withProvenance(new Set([id]));
  if (typeof raw === "string") return z.string.encode(raw).withProvenance(new Set([id]));
  if (typeof raw === "boolean") return z.boolean.encode(raw).withProvenance(new Set([id]));
  throw new Error(`fixtures.ts stampFresh: unsupported raw type ${typeof raw} minting (src ${String(raw)})`);
}

export interface LawEnv {
  readonly env: Environment;
  /** Ids minted by this env's `src`, in call order — read AFTER the mint3 snippet
   *  (or any further `src` calls) has run. */
  readonly mintedIds: readonly number[];
}

/**
 * A fresh capability env armed with the two harness-only bindings every carrier's
 * `mint3` snippet needs — `src` and `borrow-array` — NEITHER a rosetta, both bound
 * bare via `env.set`, for the SAME reason: a rosetta's `schemeToJs` would strip
 * each arg's box before `fn` ever saw it (see rosetta.ts), which is fine for a
 * function that genuinely wants JS-side values but wrong for one that needs to
 * re-stamp the ORIGINAL boxed value's exact type/identity. A bare JS function is
 * dispatched by the evaluator's plain-function call path (`Reflect.apply(fn,
 * callCtx, wrappedArgs)`, eval/evaluator.ts) with the already-evaluated,
 * ALREADY-BOXED scheme args — untouched by any membrane unwrap.
 *
 *  - `src`: a Rosetta-IN SOURCE minting one fresh provenance point per call (P11),
 *    independent of argument type. `schemeToJs`'s honest per-type unwrapping
 *    (rosetta.ts — e.g. ACharacter → a bare JS string) is a ONE-WAY projection
 *    (P9): re-boxing a bare string can't recover whether it started life as an
 *    AString or an ACharacter, so a rosetta-wrapped `src` couldn't round-trip a
 *    character carrier's elements. Binding bare sidesteps the unwrap entirely —
 *    `stampFresh`'s `raw instanceof AValue` arm always fires, preserving the
 *    original element's exact class.
 *  - `borrow-array`: handing the raw JS array of already-boxed args straight to
 *    `fromJS` (membrane.ts) is exactly the "fromJS on a JS array of boxed
 *    elements" idiom: `fromJS`'s array branch (`new AJSArray(CONSTANT_CTX,
 *    value)`) keeps the array's members exactly as given — each `src`-minted box
 *    survives.
 */
export async function withLawEnv(): Promise<LawEnv> {
  const env = await freshEnv();
  const mintedIds: number[] = [];
  let seq = 0;
  env.set("src", (raw: unknown) => {
    const id = ++seq;
    mintedIds.push(id);
    return stampFresh(raw, id);
  });
  env.set("borrow-array", (...args: SchemeValue[]) => fromJS(args));
  return { env, mintedIds };
}

export interface Minted {
  readonly env: Environment;
  readonly value: SchemeValue;
  /** The 3 ids minted by this exact mint3 call, in call/argument order. */
  readonly ids: readonly [number, number, number];
}

/** Runs a carrier's `mint3` snippet in a fresh law env, returning the minted
 *  container plus its 3 element ids in argument order. Call once per test — a
 *  fresh env (and so a fresh id sequence starting at 1) every time, so ids are
 *  always `[1,2,3]` and never collide across assertions. */
export async function mint3(carrier: CarrierRow): Promise<Minted> {
  const { env, mintedIds } = await withLawEnv();
  const [value] = (await execState(carrier.mint3, { env })).values;
  if (mintedIds.length !== 3) {
    throw new Error(`fixtures.ts mint3(${carrier.carrier}): expected 3 src mints, got ${mintedIds.length}`);
  }
  return { env, value, ids: mintedIds as [number, number, number] };
}

export interface MintedPair {
  readonly env: Environment;
  readonly a: SchemeValue;
  readonly b: SchemeValue;
  readonly idsA: readonly [number, number, number];
  readonly idsB: readonly [number, number, number];
}

/**
 * TWO independent instances of the same carrier, minted from ONE shared `src`
 * sequence (so `b`'s ids continue from `a`'s — `[1,2,3]` then `[4,5,6]`). Used by
 * two-operand terms (concat's second operand, equal?'s "compare a different
 * instance" arm) that need genuinely distinct provenance per operand.
 */
export async function mint3Pair(carrier: CarrierRow): Promise<MintedPair> {
  const { env, mintedIds } = await withLawEnv();
  const [a] = (await execState(carrier.mint3, { env })).values;
  const idsA = [...mintedIds] as [number, number, number];
  const [b] = (await execState(carrier.mint3, { env })).values;
  const idsB = mintedIds.slice(idsA.length) as [number, number, number];
  return { env, a, b, idsA, idsB };
}

/**
 * Per-element provenance, in order, for the carriers that genuinely box each
 * element individually (Pair spine / Vector / borrowed JSArray / Dict values).
 * `null` for AString/ABytevector: R7RS chars/bytes are NOT individually grounded
 * (see AString's `arrival/tagless-final/length` doc — "a string's characters carry
 * NO element ids") — their only provenance signal is the CONTAINER's own top-level
 * set, read via `.provenance` directly, not this reader.
 */
export function elementBoxes(value: unknown): readonly (readonly number[])[] | null {
  if (value instanceof APair) {
    const out: (readonly number[])[] = [];
    let n: unknown = value;
    while (n instanceof APair) {
      out.push([...(n.car instanceof AValue ? n.car.provenance : [])].sort((a, b) => a - b));
      n = n.cdr;
    }
    return out;
  }
  if (value instanceof AVector) {
    return value.__vector__.map((e) => [...(e instanceof AValue ? e.provenance : [])].sort((a, b) => a - b));
  }
  if (value instanceof AJSArray) {
    return value.source.map((e) => [...(e instanceof AValue ? e.provenance : [])].sort((a, b) => a - b));
  }
  if (value instanceof ADict) {
    return value.keys().map((k) => {
      const v = value.get(k);
      return [...(v instanceof AValue ? v.provenance : [])].sort((a, b) => a - b);
    });
  }
  return null;
}

/**
 * Deep-unwrap to plain JS for VALUE comparisons — recurses through `.valueOf()`
 * so a leftover boxed leaf (AVector/AJSArray's `arrival/toJS` intentionally
 * returns elements still-boxed, "lazily", per their own doc comments) compares
 * equal to its raw counterpart. Sidesteps AExact-vs-AInexact exactness noise too
 * (both `.valueOf()` to the same JS number). NOT a provenance reader — this is
 * for the "value: reference semantics" cells only.
 */
export function toPlain(value: unknown): unknown {
  // `["arrival/toJS"]()`, NOT `.valueOf()` — APair/ADict don't override valueOf (it inherits
  // Object.prototype's `return this`), which would recurse forever on a boxed container.
  // Every AValue implements toJS (AValue.ts's abstract contract), and some (AVector/AJSArray)
  // deliberately leave elements still-boxed ("convert lazily") — recursing `toPlain` over the
  // toJS result unwraps those too, so the comparison is genuinely deep either way.
  if (value instanceof AValue) return toPlain((value as AValue)["arrival/toJS"]());
  if (Array.isArray(value)) return value.map(toPlain);
  if (value instanceof Uint8Array) return Array.from(value);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, toPlain(v)]));
  }
  return value;
}

/**
 * The CONTAINER's own top-level provenance, sorted — R2/C1's "grouping-fact" reader
 * (`value.provenance` directly, never a deep walk). `[]` for a non-AValue. Distinct
 * from `elementBoxes` (per-element) and `deepIds` (deep-collapsed) — this is
 * specifically the flat stamp the container-box law rows (PROXIED/PROVENANCED/MINTED,
 * `_tables/terms.ts`'s `containerBox`) assert on.
 */
export function containerProv(value: unknown): readonly number[] {
  return value instanceof AValue ? [...value.provenance].sort((a, b) => a - b) : [];
}

/**
 * Deep-collapsed provenance of a result — the union of every reachable AValue's
 * OWN point ids (P10 conservation's oracle). Delegates to the production
 * `collapseProvenance` (provenance-collapse.ts) for the carriers it walks
 * (Pair/Vector/AJSArray/raw Array); EXTENDS it for ADict, whose values
 * `collapseProvenance` does not deep-walk (its own doc: "Foreign-object MEMBERS
 * are not walked") — a dict's per-key values are walked here explicitly so the
 * conservation law has a real oracle for that carrier too.
 */
export function deepIds(value: unknown): ReadonlySet<number> {
  const acc = new Set(collapseProvenance(value));
  if (value instanceof ADict) {
    for (const k of value.keys()) {
      for (const p of collapseProvenance(value.get(k))) acc.add(p);
    }
  }
  return acc;
}
