/**
 * verdict/value-equal — `Object.is`-based structural equality + a
 * sentinel-faithful renderer, the two pure value utilities the oracle's
 * agreement law and the probe verdict both stand on.
 *
 * Lifted out of `oracle/harness.ts` (which imports `tsx/esm/api` at module load)
 * so a compiler-side consumer — `probe/verdict.ts` → `seal` → mcp-worker — can
 * reach them without dragging tsx into a browser/edge bundle. Pure: no external
 * dependency, no node builtin. The differential oracle imports these back from
 * here (down-dependency: `arrival-mercury-oracle` → `arrival-mercury`).
 */

const bigintEqualsNumber = (big: bigint, num: unknown): boolean =>
  typeof num === "number" && Number.isInteger(num) && BigInt(num) === big;

function isPlainObjectLike(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  // Dict faces are plain objects (or null-proto). A Date/RegExp/class instance
  // must NOT compare as an (often empty) key-set — that greened `new Date(0)`
  // vs `new Date(1)`. Non-plain objects fall through to identity (Object.is).
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function sameKeysDeep(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && oracleEqual(a[k], b[k]));
}

/**
 * Object.is-based equality, recursive over arrays/dicts, proxy-transparent
 * (`Array.isArray` unwraps a Proxy to its target per spec, so egress-proxy
 * results compare structurally). `Object.is` as the scalar default — not `===`
 * — is what makes the `-0`/`NaN` eqv?-sentinel rows and the general numeric
 * path share one function (spec §4.2). The bigint branch is host-only: scheme
 * numeric values never egress as bigint post one-number-rework; it exists
 * solely for an opaque HOST bigint pass-through reaching the comparator.
 */
export function oracleEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "bigint" && typeof b === "bigint") return a === b;
  if (typeof a === "bigint") return bigintEqualsNumber(a, b);
  if (typeof b === "bigint") return bigintEqualsNumber(b, a);
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b); // NaN≡NaN, +0≢−0
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => oracleEqual(x, b[i]));
  if (isPlainObjectLike(a) && isPlainObjectLike(b)) return sameKeysDeep(a, b);
  return Object.is(a, b);
}

/** Render a value for a verdict/failure message — never throws; bigint-safe and
 *  sentinel-faithful (`JSON.stringify` would silently print NaN as `null` and
 *  −0 as `0` — exactly the values the eqv?-sentinel rows exist to distinguish). */
export function show(v: unknown): string {
  if (typeof v === "number" && Number.isNaN(v)) return "NaN";
  if (typeof v === "number" && Object.is(v, -0)) return "-0";
  try {
    return (
      JSON.stringify(v, (_k, x: unknown) =>
        typeof x === "bigint"
          ? `${x}n`
          : typeof x === "number" && Number.isNaN(x)
            ? "NaN"
            : typeof x === "number" && Object.is(x, -0)
              ? "-0"
              : x,
      ) ?? String(v)
    );
  } catch {
    return String(v);
  }
}
