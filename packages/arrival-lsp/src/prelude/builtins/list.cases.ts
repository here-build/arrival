// ─────────────────────────────────────────────────────────────────────────────
// Bite cases for `list` — variadic list constructor (list.d.ts → `list<T>(...xs: T[]): List<T>`).
// expect-type assertions over the ambient `__arr`; inputs are WIDENED literals so
// results are exact brands — positives pin with `.toEqualTypeOf<T>()` (an arg-rot
// OR a return→any rot both bite). Empty invocation → List<never>. Negatives use
// `// @ts-expect-error`: a heterogeneous arg bites at the call (2345), a wrong-typed
// threaded result at the assignment (2322).
// Base vocab (`List`/`SNum`) is ambient from ../types.d.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { expectTypeOf } from "vitest";

// Constructing a List<SNum> from SNum arguments — result is List<SNum>.
expectTypeOf(__arr.list(1, 2, 3)).toEqualTypeOf<List<SNum>>();
// Empty invocation — no args, so T widens to unknown → List<unknown>.
expectTypeOf(__arr.list()).toEqualTypeOf<List<unknown>>();

// @ts-expect-error heterogeneous args: 'oops' is not assignable to the inferred T=SNum
__arr.list(1, "oops");
// @ts-expect-error assigning a List<SNum> to a scalar SNum bites (2322)
const n: SNum = __arr.list(1, 2, 3);
