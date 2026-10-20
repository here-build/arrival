// ----------------------------------------------------------------------
// The syntax-rules door: what a macro USE that the engine rejects throws.
//
// An ArrivalError, so the trampoline's failAndWrap rethrows it as itself (class, hint and
// location intact) instead of wrapping it as a foreign throw. Stamped with the USE-SITE
// location — the form the author wrote — and carrying the engine's teaching hint.
// ----------------------------------------------------------------------
import { ArrivalError, formatLocation, type ErrorClass, type SourceLocation } from "../../errors.js";

export interface SyntaxRulesErrorFacts {
  /** The corrected form the door teaches (string, or several clear readings). */
  hint?: string | string[];
  /** Source location of the macro USE. */
  location?: SourceLocation;
  /** The macro definition (`syntax-rules` form) the use went through, for the message tail. */
  macro?: string;
  cause?: Error;
}

export class SyntaxRulesError extends ArrivalError {
  public readonly name = "SyntaxRulesError";
  readonly "arrival/error-category": ErrorClass = "unsupported-form";
  readonly hint?: string | string[];
  readonly location?: SourceLocation;

  constructor(message: string, facts: SyntaxRulesErrorFacts = {}) {
    const { hint, location, macro, cause } = facts;
    const readings = Array.isArray(hint) ? hint.join(" | ") : hint;
    const taught = readings === undefined ? "" : ` — ${readings}`;
    super(
      `${message}${location ? ` at ${formatLocation(location)}` : ""}${taught}${macro ? `\nin macro:\n  ${macro}` : ""}`,
      [],
      cause,
    );
    this.hint = hint;
    this.location = location;
  }
}
