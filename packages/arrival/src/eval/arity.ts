/**
 * Arity check at Scheme-side application (R7RS §4.1.4). One helper, three callers:
 * `evaluatePair` (`(f …)`), `=>` (`cond`/`case` receiver), and the `apply` native.
 *
 * NOT called from `applyCallback` — the host→Scheme HOF path keeps JS conventions
 * (a JS `.map` hands the callback `(value, index, array)`), and a `{0, null}` arity
 * (bare host fn, door procedure, opaque contract) is never enforced.
 */
import { ArityMismatchError } from "../errors.js";
import { ALambda, type ACallable } from "../values/primitives/ACallable.js";

export function assertArity(fn: ACallable, received: number): void {
  // `is_applyable` admits every value carrying the apply term — a self-applying
  // keyword (`(:key obj)`) is one and declares no arity. Unknown arity is never enforced.
  const arity = (fn as { arity?: ACallable["arity"] }).arity;
  if (arity === undefined) return;
  const { min, max } = arity;
  if (received >= min && (max === null || received <= max)) return;
  throw new ArityMismatchError(procedureName(fn), { min, max }, received, parameterList(fn));
}

function procedureName(fn: ACallable): string {
  const raw = (fn as { __name__?: string | symbol }).__name__ ?? (fn as { name?: string | symbol }).name;
  if (typeof raw === "symbol") return raw.description ?? "procedure";
  return raw === undefined || raw === "" ? "procedure" : String(raw);
}

/** `(a b . rest)` for lambdas whose parameter names are known; a collapsed TS signature
 *  for natives that declare one; else nothing (the count in the message still stands). */
function parameterList(fn: ACallable): string | undefined {
  if (fn instanceof ALambda) {
    const params = fn.__params__;
    if (params === undefined) return undefined;
    const rest = fn.arity.max === null ? " . rest" : "";
    return `(${params.join(" ")}${rest})`;
  }
  const type = (fn as { contract?: { type?: unknown } }).contract?.type;
  if (typeof type !== "string") return undefined;
  const oneLine = type.replaceAll(/\s+/g, " ").trim();
  return oneLine.length <= 160 ? oneLine : undefined;
}
