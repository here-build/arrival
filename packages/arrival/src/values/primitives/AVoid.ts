/**
 * Void — the unspecified-value singleton. The result of expressions whose value
 * R7RS leaves *unspecified*: `(if #f #f)`, a not-taken `when`/`unless`, and the
 * side-effecting procedures (`set!`, `for-each`, `display`, `vector-set!`, …).
 *
 * Distinct from `nil` (`'()` — the empty LIST) and from `#f`: "computed no useful
 * value" is neither "the empty list" nor "false". One identity-compared singleton,
 * mirroring {@link EOF} — it replaces the former inconsistency where unspecified was
 * raw JS `undefined` on some paths and `nil` on others.
 *
 * Membrane (Rosetta concept-translation): JS `undefined` (no value) ↔ void; JS
 * `null` (explicit null) ↔ nil. The two host bottoms map to the two Scheme
 * absences. See docs/working-proposals/arrival-graal-membrane-dissolution.md.
 *
 * Mode: void EXISTS in both modes — the loose default treats it as an ordinary
 * (truthy) value; strict mode (the R7RS portability control) is where reliance on
 * our non-standard surface for it — the readable `#void` literal — is rejected. The
 * value class itself is mode-agnostic; the divergence lives at the reader.
 */
import { CLASS } from "../../well-known-symbols.js";
import { CONSTANT_CTX, type RunContext } from "./RunContext.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { INTEROP_BOUNDARY } from "../../interop-access.js";

export class AVoid extends AValue {
  static [INTEROP_BOUNDARY] = true;
  static [CLASS] = "void";
  readonly kind = "void" as const;

  constructor(ctx: RunContext, provenance: ReadonlySet<number> = EMPTY_PROVENANCE) {
    super(ctx, provenance);
  }

  /** Non-readable external representation, mirroring `#<eof>`. The readable `#void`
   *  is a loose-mode reader tolerance, not a round-trip form — unspecified is not
   *  meant to round-trip. */
  toString(): string {
    return "#<void>";
  }

  ["arrival/print"](): string {
    return this.toString();
  }

  /** Outbound translation: void → JS `undefined` (inverse of the `undefined` boxer). */
  toJs(): undefined {
    return undefined;
  }

  withProvenance(p: ReadonlySet<number>): AVoid {
    return new AVoid(this.ctx, p);
  }

  // Setoid (Fantasy Land) — every void is equal (identity singleton; provenance
  // clones included), matching eq?'s instanceof check.
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof AVoid;
  }
}

/** The one unspecified value — identity-compared; returned for every "no useful
 *  value" site. Carries CONSTANT_CTX, exactly as `nil`/`eof` do. */
export const theVoid = new AVoid(CONSTANT_CTX);

