// -------------------------------------------------------------------------
// ArrivalError — the single concrete arrival / Scheme-level error.
// -------------------------------------------------------------------------
//
// Was `SchemeError` over a one-field abstract `ArrivalError` base (a dead `args`
// slot); that redundant layer is dissolved into this concrete class. Kept a LEAF —
// only the CLASS marker + a TYPE-only StackFrame — so the value terms (and any
// sibling error subclass) can throw / extend it without importing the evaluator (the
// abstract base existed precisely so this stayed cycle-free; the concrete class
// inherits that discipline).

import { CLASS, LOCATION } from "./well-known-symbols.js";
import { formatLocation, type SourceLocation } from "./errors.js";
import type { StackFrame } from "./eval/evaluator.js";
import type { SchemeValue } from "./values/types.js";

/** A SchemeValue's source location off its LOCATION metadata, if any (leaf-local — the
 *  evaluator's richer `formatCode` renderer is not reachable from a leaf, so a stack frame's
 *  code prints via its own `String()` repr). */
function readLocation(code: SchemeValue): SourceLocation | undefined {
  if (code && typeof code === "object" && LOCATION in code) {
    return (code as Record<symbol, SourceLocation | undefined>)[LOCATION];
  }
  return undefined;
}

export class ArrivalError extends Error {
  static [CLASS] = "arrival-error";
  public readonly name: string = "ArrivalError";

  constructor(
    message: string,
    public readonly schemeStack: StackFrame[] = [],
    public readonly cause?: Error,
  ) {
    super(message);
  }

  toString(): string {
    let result = `${this.name}: ${this.message}`;
    if (this.schemeStack.length > 0) {
      result += "\n\nScheme Stack Trace:";
      for (const [i, frame] of this.schemeStack.entries()) {
        const env = frame.env_name ? ` [${frame.env_name}]` : "";
        const proc = frame.procedure ? ` in ${frame.procedure}` : "";
        const loc = frame.location ?? readLocation(frame.code);
        const locStr = loc ? ` at ${formatLocation(loc)}` : "";
        result += `\n  ${i + 1}. ${String(frame.code)}${locStr}${proc}${env}`;
      }
    }
    return result;
  }
}
