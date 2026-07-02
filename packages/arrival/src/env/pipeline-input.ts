// @here.build/arrival/pipeline-input — the `pipeline/input` capability: a host-configured
// parameter surface for a scheme "pipeline" program (`params: Record<string, unknown>`,
// supplied at `.lower({ config: { params } })` time — or through `exec(src, { capabilities,
// config })`'s shared config bag, of which this capability validates only its own `params`
// slice).
//
// THE SHAPE (assembly-time materialization): the ONE host-facing verb, `pipeline-input/params`,
// is `preludeOnly` — zero-arg, returning the WHOLE validated params record as scheme data (an
// alist). It exists only while the assembly's C3 loop runs (the kernel's phase-gated prelude
// scope, kernel.ts `assembleEnv`); the capability's own prelude calls it EXACTLY ONCE and
// captures the result in an ordinary runtime define:
//
//     (define %pipeline-params (pipeline-input/params))
//
// That is the prescribed preludeOnly bridge — capture the call's RESULT at assembly time, never
// the verb (a prelude-defined lambda naming the verb would find it unbound at runtime, since
// closures walk the live chain and the phase-gated resolver has gone silent — the CONTRACT, see
// capability.ts). Everything downstream is pure scheme over that materialized record:
// `%params-ref` (alist lookup with default fallback) and the public macro
//
//     (define/pipeline-input city "string" "Berlin")
//       ⇒ (define city (%params-ref %pipeline-params 'city "Berlin"))
//
// A user program naming `pipeline-input/params` directly gets the ordinary unbound-variable
// error — nothing to seal.
//
// THE `type` SLOT IS STATIC METADATA. The macro drops it at expansion: a derivation layer reads
// it off the source form (`(define/pipeline-input name TYPE default)`) to describe the
// pipeline's parameter surface; the runtime ignores it. Per-tag validation of a host-supplied
// value belongs at the DOOR — the boundary that accepts the config (the host's own schema, or a
// derivation-checked submission) — not inside the running program. At this layer `params` is
// validated only structurally (`z.record(z.string(), z.unknown())`).
//
// NOT in BASE_PACKS: this is config-bearing (params differ per pipeline run), lowered
// per-consumer — unlike core/polyglot/srfi (assembled once into every env), a pipeline-input
// pack is assembled FRESH per run with that run's own host-supplied parameter values.

import { z } from "zod";

import { EnvCapability } from "../common/capability.js";
import { symbol } from "../common/symbol.js";
// The scheme-aware zod vocabulary — only the identity carrier `sz.value` is needed here (the
// verb's output is already-built scheme data; no codec crossing).
import * as sz from "../common/scheme-zod.js";
import { jsToScheme } from "../rosetta.js";
import { nil } from "../values/primitives/ANil.js";
import { APair } from "../values/primitives/APair.js";
import { AString } from "../values/primitives/AString.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import type { SchemeValue } from "../values/types.js";

/** Build the scheme-side params record: an ALIST of `(name . value)` with STRING keys (so the
 *  pure-scheme `%params-ref` resolves via plain `assoc`/`equal?` — no membrane accessor needed).
 *  Values are boxed generically (`jsToScheme`): scalars → the branded scheme primitives, plain
 *  objects → member-readable records. Scalars are the designed surface; richer shapes pass
 *  through as whatever the membrane makes of them. */
function paramsToAlist(params: Record<string, unknown>): SchemeValue {
  let out: SchemeValue = nil;
  for (const [key, value] of Object.entries(params).reverse()) {
    const entry = new APair(CONSTANT_CTX, new AString(CONSTANT_CTX, key), jsToScheme(CONSTANT_CTX, value));
    out = new APair(CONSTANT_CTX, entry, out);
  }
  return out;
}

/** The `pipeline/input` capability — see the file header for the full design. */
export const pipelineInputCapability = new EnvCapability("pipeline/input", {
  // `.default({})`: a config-less lower MUST succeed (the shared-config-bag posture — a consumer
  // assembling without params still gets the capability; every in-form default then fires).
  configuration: { params: z.record(z.string(), z.unknown()).default({}) },
  symbols: ({ configuration }) => ({
    // preludeOnly — assembly-time-only (the kernel's phase-gated prelude scope). The prelude
    // below is its only caller; a running program naming it gets a plain unbound error.
    "pipeline-input/params": symbol.rosetta`pipeline-input/params: () → the validated params record, as an alist`(
      { input: [], output: [sz.value], preludeOnly: true },
      () => paramsToAlist(configuration.params),
    ),
  }),
  prelude: `
    (define %pipeline-params (pipeline-input/params))

    (define (%params-ref params name default)
      (let ((hit (assoc (symbol->string name) params)))
        (if (pair? hit) (cdr hit) default)))

    (define-macro (define/pipeline-input name type default)
      \`(define ,name (%params-ref %pipeline-params ',name ,default)))
  `,
});
