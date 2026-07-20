// NATIVE_PACKS — the JS-implemented R7RS domains (chars / strings / vectors /
// bytevectors / equality / numeric / error-objects) as a capability set, the native
// half of the two-root bootstrap (docs/environments.md §ASSEMBLY). Each member is a live
// `EnvCapability`, the sole home of its domain's primitives, symbol-only (baked
// `symbol.native`/`symbol.rosetta`, no prelude/resources/deps). Sibling of
// `BASE_PACKS` (the `.scm`-defined packs onto `user_env`); together the full
// pack-assembled surface.
//
// `ensureBaseAssembled` (eval/generator-exec.ts, public alias `initBridge`)
// ASSEMBLES these onto `global_env` (the native root) via `assembleEnv` as the first
// bootstrap step — it dynamic-imports this roster, so this file must stay
// exec-edge-free (near-leaf; no module-eval cycle).

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
  // errorObjects goes last — every value-domain cluster (chars/strings/vectors/
  // bytevectors/equality/numeric) precedes it.
  errorObjects,
];
