// The value → string printer for arrival — now a ONE-FUNCTION adapter over the per-value PRINT
// protocol (values/print.ts: each AValue answers `["arrival/print"](): string`; `printValue`
// dispatches and handles the non-AValue residual — raw functions / bottoms / foreign objects). The
// old centralized type-switch here AND APair.ts's duplicate `stringifyValue` both dissolved into
// that one protocol. `toString` is what stdlib's `repr` calls — the only remaining consumer.
//
// (The former `unbox` export was dead; `map_object` / `symbolize` were used ONLY by the
// now-removed `makeDebugTracer` and went with it, leaving just this adapter. It could fold entirely
// into `repr` calling `printValue` directly — left as the thin seam for now.)
import { printValue } from "./values/print.js";

// Value → its Scheme repr. The former `quote` / `skip_cycles` / `pair_args` tail is accepted and
// ignored: print is a single canonical form now (write/display are doored — only `repr` is live).
export function toString(obj: unknown, ..._legacy: unknown[]): string {
  return printValue(obj);
}
