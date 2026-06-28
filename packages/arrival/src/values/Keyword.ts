// Keyword — the first-class marker a kernel special-form name resolves to.
//
// `lambda` / `define` / `let` / … are bound (on the scheme/core pack) to a Keyword
// carrying the special-form's dispatch name. The evaluator resolves a call's HEAD
// through the env and, when it resolves to a Keyword, dispatches the kernel handler
// `SPECIAL_FORMS[kw.name]` instead of applying it. So special-ness travels with the
// VALUE, not the spelling of the head:
//
//   (define => lambda)            ; => now holds the lambda keyword marker…
//   (=> (x) x)                    ; …and is lambda — aliasing falls out for free
//   (let ((lambda 5)) (lambda))   ; lexically shadowed → NOT special, just a call
//
// The dual of cxr: kernel-direct, yet still an ordinary, resolvable, shadowable
// symbol value. Built by `symbol.keyword` (lowered to `new Keyword(name)` in
// EnvCapability.lower); detected by the evaluator via `instanceof Keyword`.
//
// It is an AValue (not a bare class) so it survives the JS↔scheme membrane intact:
// `AValue.fromJs` returns an already-AValue as-is, where a plain object would be
// boxed to AJSObject (losing the Keyword identity, and with it the dispatch). A
// constant syntactic marker — CONSTANT_CTX, provenance-free, identity equality.
import { AValue } from "./primitives/AValue.js";
import { CONSTANT_CTX } from "./primitives/RunContext.js";

export class Keyword extends AValue {
  readonly kind = "keyword" as const;

  constructor(readonly name: string) {
    super(CONSTANT_CTX);
  }

  toJs(): unknown {
    return `#<keyword:${this.name}>`;
  }

  // A constant syntactic marker carries no provenance lineage — stamping is a no-op.
  withProvenance(): AValue {
    return this;
  }

  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof Keyword && other.name === this.name;
  }

  toString(): string {
    return `#<keyword:${this.name}>`;
  }

  // Print protocol — BEHAVIOR-PRESERVING. The printer renders a Keyword through its generic
  // constructor-name branch (`#<Keyword>`), NOT this toString (`#<keyword:name>`): the printer's
  // own-toString shortcut needs `hasOwnProperty("toString")`, which is false for a prototype
  // method. (toString's `#<keyword:name>` is more informative — flagged as a wire-up improvement.)
  ["arrival/print"](): string {
    return `#<${this.constructor.name}>`;
  }
}
