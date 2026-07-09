// NATIVE_PACKS — the complete native foundation: the value-domain primitive clusters
// plus the error-object predicates, as assembled capability packs.
//
// These are the JS-implemented R7RS domains (chars / strings / vectors / bytevectors /
// equality / numeric / error-objects). `ensureBaseAssembled` (eval/generator-exec.ts,
// public alias `initBridge`) ASSEMBLES them onto `global_env` (the native root) via
// `assembleEnv` as the first step of the lazy runtime bootstrap — it dynamic-imports
// this roster, so this file must stay exec-edge-free (near-leaf; no module-eval cycle).
// Each member is a live `EnvCapability` — the sole home of its domain's primitives,
// symbol-only (`{ value }` bindings, no prelude, no resources, no deps).
//
// Sibling of `BASE_PACKS` (the `.scm`-defined packs assembled onto `user_env`).
// Together they are the full pack-assembled surface. This roster ABSORBED bridge.ts's
// `GLOBAL_NATIVE_PACKS` (= NATIVE_PACKS + the exceptions pack) when bridge.ts — the
// LIPS-era monolith's last husk — was deleted; the split had no remaining reason once
// the error-object predicates became an ordinary pack file (r7rs/error-objects.ts).

import type { EnvCapability } from "../common/capability.js";
import bytevectors from "./r7rs/bytevectors.js";
import chars from "./r7rs/chars.js";
import equality from "./r7rs/equality.js";
import errorObjects from "./r7rs/error-objects.js";
import numeric from "./r7rs/numeric.js";
import strings from "./r7rs/strings.js";
import vectors from "./r7rs/vectors.js";

export const NATIVE_PACKS: readonly EnvCapability[] = [
  chars,
  strings,
  vectors,
  bytevectors,
  equality,
  numeric,
  // Last, preserving the assembly order GLOBAL_NATIVE_PACKS had (it appended the
  // exceptions pack after every value-domain cluster).
  errorObjects,
];
