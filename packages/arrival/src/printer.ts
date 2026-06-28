// The value → string printer for arrival — now a THIN adapter over the per-value PRINT protocol
// (values/print.ts: each AValue answers `["arrival/print"](): string`; `printValue` dispatches and
// handles the non-AValue residual — raw functions / bottoms / foreign objects). The old centralized
// type-switch here (get_instances / get_native_types / function_to_string / is_native_function /
// user_repr / str_mapping) AND APair.ts's duplicate `stringifyValue` both dissolved into that one
// protocol — each value now renders itself, recursion is just the child's own `["arrival/print"]()`.
//
// `toString` is what stdlib's `repr` calls; `map_object` / `symbolize` are the value-tree helpers
// stdlib's builtins/tracer use. (The former `unbox` export was dead — no importer — and is gone.)
import { printValue } from "./values/print.js";

// Value → its Scheme repr. The former `quote` / `skip_cycles` / `pair_args` tail is accepted and
// ignored: print is a single canonical form now (write/display are doored — only `repr` is live).
export function toString(obj: unknown, ..._legacy: unknown[]): string {
  return printValue(obj);
}

// ----------------------------------------------------------------------
// Debug helper usable with JSON.stringify — surfaces symbol-keyed props as strings.
/* c8 ignore next 18 */
export function symbolize(obj: unknown): unknown {
  if (obj && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    const symbols = Object.getOwnPropertySymbols(obj);
    for (const key of symbols) {
      const name = key.toString().replace(/Symbol\(([^)]+)\)/, "$1");
      result[name] = toString((obj as Record<symbol, unknown>)[key]);
    }
    const props = Object.getOwnPropertyNames(obj);
    for (const key of props) {
      const o = (obj as Record<string, unknown>)[key];
      result[key] = o && typeof o === "object" && o.constructor === Object ? symbolize(o) : toString(o);
    }
    return result;
  }
  return obj;
}

// ----------------------------------------------------------------------
export function map_object(
  object: Record<PropertyKey, unknown>,
  fn: (v: unknown) => unknown,
): Record<PropertyKey, unknown> {
  const props = Object.getOwnPropertyNames(object);
  const symbols = Object.getOwnPropertySymbols(object);
  const result: Record<PropertyKey, unknown> = {};
  for (const key of [...props, ...symbols]) {
    result[key] = fn(object[key]);
  }
  return result;
}
