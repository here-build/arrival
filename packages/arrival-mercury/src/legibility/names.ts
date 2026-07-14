/**
 * ADAPTED-AS-CHUNK (constitution §4.5's copy-as-chunk discipline, applied a second
 * time — ../walker/names.ts already did this once for `cleanName`/`nameCandidates`).
 * Source: `inhuman/public-packages/mercury/src/names.ts`'s `elementName`, RETARGETED
 * from the scheme parse AST (`Node`) to the Residual algebra's receiver expressions
 * (`R`) — the LEGIBILITY pass runs post-walk, over residuals, never over scheme
 * source (constitution §3.5's singularization leg). Same `pluralize` dependency,
 * same version pin (this package's `package.json`: `"pluralize": "8.0.0"`, copied
 * from mercury's own pin per `.claude/rules/npm-version-pinning.md`'s "copy from a
 * known-good sibling package.json").
 *
 * Never returns "acc" (reserved for the reduce accumulator elsewhere, matching
 * mercury's own exclusion) or the input unchanged (a singular collection name —
 * "pool", "data" — has nothing to gain from singularizing).
 */
import pluralize from "pluralize";

import { cleanName } from "../walker/index.js";
import type { R } from "../residual/types.js";

/**
 * A readable singular element name for a `.map`-style receiver expression, or
 * `undefined` (the caller keeps whatever name the walker minted). Fires on the
 * residual shapes that correspond to mercury's three recognized scheme forms:
 *
 *   Ref(xs)                              → "example"  (`examples.map(...)`)
 *   Index(recv, Lit({k:"string", …}))     → "score"    (`(:scores c)` — the
 *                                                        keyword-accessor's raw
 *                                                        dict key)
 *   Member(recv, name)                    → cleanName(name)
 *   Call(Ref(b)|RuntimeRef(s), …)         → "score"    (`(scores a)` — a getter
 *                                                        call; the callee's own
 *                                                        name)
 */
export function elementNameOf(recv: R): string | undefined {
  let base: string | undefined;
  if (recv.t === "Ref") {
    base = recv.binding.text;
  } else if (recv.t === "RuntimeRef") {
    base = recv.symbol;
  } else if (recv.t === "Index" && recv.index.t === "Lit" && recv.index.value.k === "string") {
    base = recv.index.value.value; // the keyword-accessor's raw dict key, e.g. (:scores c)
  } else if (recv.t === "Member") {
    base = recv.name;
  } else if (recv.t === "Call") {
    const callee = recv.callee;
    if (callee.t === "Ref") base = callee.binding.text;
    else if (callee.t === "RuntimeRef") base = callee.symbol;
  }
  if (base === undefined || base === "") return undefined;
  const cleaned = cleanName(base);
  const singular: string = pluralize.singular(cleaned);
  if (!singular || singular === cleaned || singular === "acc") return undefined;
  return singular;
}
