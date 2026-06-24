// -------------------------------------------------------------------------
// Arrival Exception — base class for error function and Scheme-level errors
// -------------------------------------------------------------------------

import { CLASS } from "./well-known-symbols.js";
import type { SchemeValue } from "./values/types.js";

export abstract class ArrivalError extends Error {
  static [CLASS] = "arrival-error";

  public abstract readonly name: string;

  constructor(
    message: string,
    public readonly args?: SchemeValue,
  ) {
    super(message);
  }
}
