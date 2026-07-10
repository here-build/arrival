// collectPrelude — every capability's `.spec.prelude`, DAG order (deps before dependents,
// matching lower()'s own apply order), deduplicated by capability identity. Exists so an
// editor/type-lens's ambient scheme vocabulary can be derived from the REAL assembled
// capability set instead of a hand-picked subset that silently drifts (the class of bug
// this fixes: `define/overridable`'s macro read as unresolved in studio's live editor
// because the caller named two capabilities' preludes by hand instead of walking the set).
import { describe, expect, it } from "vitest";
import { EnvCapability, collectPrelude } from "../capability.js";

describe("collectPrelude", () => {
  // INVARIANT: returns a single capability's own prelude verbatim.
  it("returns a single capability's own prelude", () => {
    const a = new EnvCapability("a", { prelude: "(define a 1)" });
    expect(collectPrelude([a])).toBe("(define a 1)");
  });

  // INVARIANT: a dependency's prelude is ordered before its dependent's own, matching lower()'s apply order.
  it("includes a dep's prelude BEFORE the dependent's own (matches apply order)", () => {
    const base = new EnvCapability("base", { prelude: "(define base 1)" });
    const dependent = new EnvCapability("dependent", { prelude: "(define dependent 2)", deps: [base] });
    expect(collectPrelude([dependent])).toBe("(define base 1)\n(define dependent 2)");
  });

  // INVARIANT: a diamond-shaped dep graph's shared prelude is deduplicated, appearing exactly once.
  it("deduplicates a diamond-shaped dep graph — the shared dep's prelude appears ONCE", () => {
    const shared = new EnvCapability("shared", { prelude: "(define shared 0)" });
    const left = new EnvCapability("left", { prelude: "(define left 1)", deps: [shared] });
    const right = new EnvCapability("right", { prelude: "(define right 2)", deps: [shared] });
    const result = collectPrelude([left, right]);
    expect(result.match(/define shared/g)?.length).toBe(1);
    expect(result).toBe("(define shared 0)\n(define left 1)\n(define right 2)");
  });

  // INVARIANT: a capability with no prelude contributes no entry (no stray blank lines).
  it("skips a capability with no prelude — no stray blank entries", () => {
    const noPrelude = new EnvCapability("no-prelude", {});
    const withPrelude = new EnvCapability("with-prelude", { prelude: "(define x 1)" });
    expect(collectPrelude([noPrelude, withPrelude])).toBe("(define x 1)");
  });

  // INVARIANT: empty input yields an empty string.
  it("empty input yields an empty string", () => {
    expect(collectPrelude([])).toBe("");
  });
});
