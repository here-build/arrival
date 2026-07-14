// idiom-routing — B8 + Tier-C "doors we owe" (benchmark-defect-register.md). A model
// reaching for another dialect's syntax (Racket `#:kwargs`) or a capability that sounds
// standard but isn't bound here (`require`, `with-input-from-file`, `read-all`) hits a bare
// "Unbound variable" today and burns a round rediscovering the native form. This is a
// DISJOINT, name-exact gate from `suggestFromVocabulary`'s fuzzy typo matching (that gate
// stays untouched — GATING load-bearing constraint in unbound-variable.ts: a hint fires only
// for a close miss of a name that EXISTS in vocabulary; these idioms exist in NO vocabulary,
// so they would never fire through it) — a small hardcoded table of known dead-end idioms,
// same family as the existing `SYNTH_NAMES` (car/cdr) seed.

import { describe, expect, it } from "vitest";
import { exec } from "../../index.js";
import { unboundVariableError } from "../../unbound-variable.js";

describe("unboundVariableError — idiom routing (B8: Racket #:kwargs)", () => {
  it("routes a #:name Racket keyword token to the arrival :name spelling", () => {
    const err = unboundVariableError("#:query");
    expect(err.message).toMatch(/Racket keyword syntax/);
    expect(err.message).toMatch(/:query/);
    expect(err.message).not.toMatch(/#:query — did you mean/); // not a fuzzy match — a routing hint
    expect(err.enriched).toBe(true);
  });

  it("LIVE: (#:query 1) throws the routing hint, not the bare wall", async () => {
    await expect(exec("#:query")).rejects.toThrow(/Racket keyword syntax/);
  });

  it("an ordinary unbound name is unaffected (idiom gate is name-exact, not a false-positive net)", () => {
    const err = unboundVariableError("csv-content");
    expect(err.message).toBe("Unbound variable `csv-content'");
    expect(err.enriched).toBe(false);
  });
});

describe("unboundVariableError — idiom routing (Tier C: require / file IO dead-ends)", () => {
  it("(require ...) routes to the bound parsers instead of a bare wall", () => {
    const err = unboundVariableError("require");
    expect(err.message).toMatch(/parse-json/);
    expect(err.message).toMatch(/detect-parse/);
    expect(err.enriched).toBe(true);
  });

  it("with-input-from-file routes to the same no-file-IO explanation", () => {
    const err = unboundVariableError("with-input-from-file");
    expect(err.message).toMatch(/detect-parse/);
    expect(err.enriched).toBe(true);
  });

  it("read-all routes to the same no-file-IO explanation", () => {
    const err = unboundVariableError("read-all");
    expect(err.message).toMatch(/detect-parse/);
    expect(err.enriched).toBe(true);
  });

  it("LIVE: (require 'scheme/parse-json) throws the routing hint through real exec", async () => {
    await expect(exec("(require 'scheme/parse-json)")).rejects.toThrow(/parse-json/);
  });
});
