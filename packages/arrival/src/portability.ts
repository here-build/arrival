// PortabilityError + strictGate — the loose/strict divergence mechanism.
//
// arrival's LOOSE mode (the default) tolerates modern-language conveniences a stock R7RS
// Scheme does not — e.g. the generic `(map f #(...))` over a vector (R7RS `map` is a LIST
// operation; vectors use `vector-map`). STRICT mode (`RunContext.strict`) is the R7RS-
// portability CONTROL: it REJECTS those tolerances with an educational error, so a user can
// test whether their program is portable to a stock Scheme and learn the exact divergence.
//
// Because every tagless method receives the run's RunContext, a divergence is gated AT the
// method: `strictGate(runCtx, {...})` is the single home for the `if (runCtx.strict) throw …`
// pattern that ANil's car/cdr nil-tolerance pioneered inline. A loose tolerance reads as a
// one-line gate at the top of its term method; loose mode is a no-op, strict mode explains.
//
// Sibling of purity.ts (PurityError / errors-as-doors): a specific arrival error + the logic
// that throws it, kept a LEAF (only ArrivalError + the well-known CLASS marker) so the value
// terms can throw it without importing the evaluator world.
import { CLASS } from "./well-known-symbols.js";
import { ArrivalError } from "./ArrivalError.js";

/** A loose-mode tolerance rejected by strict (R7RS-portability) mode — carries the diverging
 *  op (a routing/telemetry key, like PurityError.feature), the spec rule strict enforces, and
 *  the portable alternative to reach for. */
export class PortabilityError extends ArrivalError {
  static [CLASS] = "portability-error";
  public readonly name = "PortabilityError";

  constructor(
    /** The diverging op, e.g. "map" — the routing/telemetry key. */
    public readonly op: string,
    /** The spec rule strict mode enforces, e.g. "R7RS `map` operates on lists; a vector is not a list". */
    public readonly rule: string,
    /** The portable alternative, e.g. "use `vector-map` for vectors". */
    public readonly alternative?: string,
  ) {
    super(`${op}: not portable in strict mode — ${rule}` + (alternative ? ` (${alternative})` : ""));
  }
}

/** Loose/strict divergence gate. In strict (R7RS-portability) mode a loose tolerance throws a
 *  PortabilityError explaining the divergence; in loose mode (the default) it is a no-op and
 *  the caller proceeds. Reads `strict` structurally so it needs no RunContext import. */
export function strictGate(
  runCtx: { readonly strict: boolean } | undefined,
  divergence: { op: string; rule: string; alternative?: string },
): void {
  if (runCtx?.strict) {
    throw new PortabilityError(divergence.op, divergence.rule, divergence.alternative);
  }
}
