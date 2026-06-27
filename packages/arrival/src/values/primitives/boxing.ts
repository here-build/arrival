import invariant from "tiny-invariant";
import type { RunContext } from "./RunContext.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";

/**
 * The JS → Scheme boxing membrane: a `typeof`-tag → boxer registry, populated by
 * each value-type module at load. Registration is BOOT-ONLY — the tag set is JS's
 * fixed `typeof` family (string/number/bigint/boolean/object/function + the two
 * null-ish tags), nothing registers at runtime, and there are no plugins.
 *
 * Why a registry, not a `switch` in `fromJs`: a switch would force `fromJs` to
 * import every subtype — but subtypes already `extends AValue` (cycle) — AND it
 * would drag the heavy membrane (the object/function boxers live in membrane.ts,
 * which pulls the evaluator) into the value layer. The registry inverts the
 * dependency: subtypes and the membrane self-register; this module imports only
 * AValue.
 *
 * Why this lives OFF the AValue class: `registerBoxer` is a write into the
 * membrane's core conversion path, and AValue is the class most likely to leak to
 * the sandbox. As a class static (`AValue.registerBoxer`) it was a poison handle on
 * a leakable surface. As a module function it is structurally unreachable — the
 * `boxers` Map is module-private, and only a module IMPORTER (never the sandbox)
 * can call `registerBoxer`. `fromJs` (read-only) is harmless and stays public.
 */
type Boxer = (ctx: RunContext, v: unknown, p: ReadonlySet<number>) => AValue;

const boxers = new Map<string, Boxer>();

/** Subtype modules call this at top-level. Registration order is not significant. */
export function registerBoxer(typeofTag: string, fn: Boxer): void {
  boxers.set(typeofTag, fn);
}

/**
 * Single JS-input membrane. Already-AValue input is returned as-is unless a
 * non-empty provenance is supplied (then `withProvenance` mints a copy); the
 * same-instance fast path is what makes this safe to call on the hot path. Throws
 * if the subtype module hasn't loaded yet — a programmer error, not a runtime one.
 */
export function fromJs(ctx: RunContext, v: unknown, provenance: ReadonlySet<number> = EMPTY_PROVENANCE): AValue {
  if (v instanceof AValue) {
    return provenance === EMPTY_PROVENANCE || provenance === v.provenance ? v : v.withProvenance(provenance);
  }

  const tag = resolveTypeofTag(v);
  const boxer = boxers.get(tag);
  invariant(boxer !== undefined, `fromJs: no boxer registered for tag "${tag}" — subtype module not loaded`);
  return boxer(ctx, v, provenance);
}

/** `null` gets its own tag — JS quirk: `typeof null === "object"`. */
function resolveTypeofTag(v: unknown): string {
  switch (true) {
    case v === null:
      return "null";
    case v === undefined:
      return "undefined";
    default:
      return typeof v;
  }
}
