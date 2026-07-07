// @here.build/arrival/r7rs/control — the control-feature / dynamics OMISSIONS.
//
// Lineage: R7RS-small (Shinn, Cowan & Gleckler, eds., 2013) — §6.10 Control
// features (call/cc, call-with-current-continuation, dynamic-wind), §4.2.6 Dynamic
// bindings (make-parameter, parameterize), §4.2.5 Delayed evaluation (delay, force,
// make-promise, delay-force).
//
// This is a DOORS-ONLY capability — it implements nothing; it argues what arrival
// omits and why. arrival is PURE DATAFLOW: every value carries the lineage of WHERE
// it was constructed, and the MCP/trace engine reads it. First-class continuations,
// dynamic binding, and delayed evaluation all tie a value's IDENTITY to WHEN/WHERE
// control re-enters or to force-time — never to a construction site — so lineage
// cannot be rooted. They are omitted BY DESIGN. Each door (errors-as-doors) names
// the omission, argues the why, and routes to the supported alternative.
//
// No value-TYPE pack owns §6.10/§4.2.5/§4.2.6 (unlike the string/vector/list
// mutators, which co-locate with their type's pack) — they share one rationale
// (identity tied to control-extent, not construction-site), so they get one
// dedicated section pack here, the parallel of "vectors own the vector mutators".
//
// SINGLE SOURCE: `r7rs/index.ts` adds this to `allR7rs`, so `base-packs.ts`
// assembles it into the base env — the doors are live in every assembled env.

import { EnvCapability } from "../../common/capability.js";
import { symbol } from "../../common/symbol.js";

export default new EnvCapability("scheme/r7rs/control", {
  symbols: {
    // §6.10 First-class continuations — non-local re-entry severs construction-site grounding.
    "call/cc": symbol.notImplemented`call/cc: first-class continuations are omitted from arrival by design — non-local re-entry severs value provenance, leaving no single construction site to root lineage at; for early exit use guard / raise (R7RS §6.11, supported)`,
    "call-with-current-continuation": symbol.notImplemented`call-with-current-continuation: first-class continuations are omitted from arrival by design — non-local re-entry severs value provenance, leaving no single construction site to root lineage at; for early exit use guard / raise (R7RS §6.11, supported)`,
    "dynamic-wind": symbol.notImplemented`dynamic-wind: omitted from arrival by design — degenerate without call/cc, and its before/after extent is dynamic state the dataflow engine cannot linearize; for teardown use (guard (e (#t (cleanup) (raise e))) ...)`,

    // §4.2.6 Dynamic bindings — identity tied to call-time extent, not construction.
    "make-parameter": symbol.notImplemented`make-parameter: dynamic binding is omitted from arrival by design — it ties a value's identity to call-time extent, not to where it was constructed; pass the value explicitly / thread it through your dataflow`,
    "parameterize": symbol.notImplemented`parameterize: dynamic binding is omitted from arrival by design — it ties a value's identity to call-time extent, not to where it was constructed; pass the value explicitly / thread it through your dataflow`,

    // §4.2.5 Delayed evaluation — identity deferred to force-time, not construction.
    "delay": symbol.notImplemented`delay: delayed evaluation is omitted from arrival by design — it defers a value's identity to force-time and the dynamic extent alive then, not to where it was constructed; compute the value where you need it`,
    "force": symbol.notImplemented`force: delayed evaluation is omitted from arrival by design — it defers a value's identity to force-time and the dynamic extent alive then, not to where it was constructed; compute the value where you need it`,
    "make-promise": symbol.notImplemented`make-promise: delayed evaluation is omitted from arrival by design — it defers a value's identity to force-time and the dynamic extent alive then, not to where it was constructed; compute the value where you need it`,
    "delay-force": symbol.notImplemented`delay-force: delayed evaluation is omitted from arrival by design — it defers a value's identity to force-time and the dynamic extent alive then, not to where it was constructed; compute the value where you need it`,
  },
});
