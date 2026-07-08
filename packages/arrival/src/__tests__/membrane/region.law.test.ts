/**
 * LAW F5 — region discipline for re-entrant crossings (P6).
 *
 * Written BEFORE its code: these are the acceptance tests for the
 * reverse-membrane migration (docs/working-proposals/
 * reverse-membrane-for-callables.md §7c). Every row is it.todo gated on that
 * landing; the migration is done when this file's todos become green tests.
 */
import { describe, it } from "vitest";

describe("a reverse lambda is region-bound to its invocation", () => {
  it.todo("calling the wrapper AFTER the symbol returned throws the escape door (educational, names the capability path)");
  it.todo("the symbol returning while wrapper calls are IN FLIGHT throws (pending > 0 at settle)");
  it.todo("run abort cancels in-flight re-entries via the scope's derived signal");
  it.todo("wrapper identity is per-(callable, scope): same lambda, same invocation → ===; new invocation → new wrapper");
  it.todo("each re-entry opens a child trace scope of the enclosing invocation — lineage nests, never attributes flat to the run root");
  it.todo("re-entry args mint under the enclosing invocation's runCtx, never CONSTANT_CTX");
  it.todo("z.procedure decode adopts the same scope token — one discipline, typed and untyped paths");
  it.todo("a persistent handler is a NAMED capability with a detached scope, not a relaxation [STAGED: post-migration]");
});
