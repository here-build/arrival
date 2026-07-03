// The cross-dialect teaching-stub pack (`env/libraries/well-known-stubs.ts`):
// famous Common Lisp / Racket / Clojure symbols with no SRFI/R7RS lineage that
// arrival deliberately does NOT implement (IO, in-place mutation, or a macro too
// dialect-specific to generalize), each bound to an errors-as-doors throw
// (PurityError) that names the reason and — where an honest one exists — the exact
// bound alternative. Mirrors `srfi-stubs.test.ts` exactly (same door-firing +
// wall→door proof shape); the two files test SIBLING, DISJOINT populations.

import { describe, expect, it } from "vitest";
import { exec, sandboxedEnv } from "../index.js";
import { assembleEnv } from "../common/kernel.js";
import { type SchemeEnv } from "../common/scheme-env.js";
import { PurityError } from "../errors.js";
import wellKnownStubs from "../env/libraries/well-known-stubs.js";

/** Assemble the stub pack onto a fresh sandboxed env; return an exec bound to it. */
async function withStubs(name: string): Promise<(src: string) => Promise<unknown[]>> {
  const env = sandboxedEnv.inherit(name);
  await assembleEnv(env as unknown as SchemeEnv, [wellKnownStubs.lower({}) as never]);
  return (src: string) => exec(src, { env: env as never });
}

/** Run `src`; report whether a PurityError door fired (directly or via `.cause`) + its message. */
async function fire(run: (src: string) => Promise<unknown[]>, src: string): Promise<{ door: boolean; message: string }> {
  try {
    await run(src);
  } catch (e) {
    const direct = e instanceof PurityError;
    const viaCause = (e as { cause?: unknown })?.cause instanceof PurityError;
    return { door: direct || viaCause, message: (e as Error)?.message ?? String(e) };
  }
  throw new Error(`expected a teaching door for: ${src}`);
}

describe("well-known-stubs — one representative door per family", () => {
  // [family label, source that reaches for a stub, load-bearing redirect substring]
  const cases: ReadonlyArray<readonly [string, string, RegExp]> = [
    ["type-of (CL) → granular predicates", "(type-of 5)", /pair\?, string\?, number\?, symbol\?, boolean\?, vector\?, dict\?, procedure\?, null\?/],
    ["<> → SRFI-26 cut placeholder / SQL not-equal, no bare value", "(<> 1 2)", /\(not \(equal\? a b\)\)/],
    ["make-hash (Racket) → dicts are native", "(make-hash)", /dicts are native/],
    ["make-hasheq (Racket) → dicts are native", "(make-hasheq)", /dicts are native/],
    ["hash-ref (Racket) → dicts are native", '(hash-ref (dict) "a")', /dicts are native/],
    ["gethash (CL) → dicts are native", '(gethash "a" (dict))', /dicts are native/],
    ["getf (CL) → dicts are native", "(getf (list 1 2) 1)", /dicts are native/],
    ["println (Clojure) → IO omitted by design", '(println "hi")', /ambient IO/],
    ["print (Clojure) → IO omitted by design", '(print "hi")', /ambient IO/],
    ["loop (CL) → map/filter/reduce/SRFI-1 helpers", "(loop)", /map\/filter\/reduce/],
    ["nreverse (CL) → reverse (non-destructive)", "(nreverse (list 1 2 3))", /reverse \(R7RS\) is bound/],
    ["for/list (Racket) → map", "(for/list)", /use \(map/],
    ["for/fold (Racket) → reduce", "(for/fold)", /use \(reduce/],
  ] as const;

  for (const [label, src, redirect] of cases) {
    it(`${label} — fires a door whose message routes to the alternative`, async () => {
      const run = await withStubs(`well-known-${label}`);
      const { door, message } = await fire(run, src);
      expect(door).toBe(true);
      expect(message).toMatch(redirect);
    });
  }

  // setf/defun ARE bound as notImplemented doors (verified in the "wall → door"
  // describe below), but calling them with an as-yet-unbound identifier argument —
  // `(setf x 1)`, `(defun foo (x) x)` — evaluates that identifier BEFORE the door
  // fires (ordinary applicative-order call, not a macro), so the observable error is
  // "Unbound variable" on the argument, not the door. This is a PRE-EXISTING,
  // accepted limitation shared with srfi-stubs.ts's own `with-open-file` (the one
  // other binding-form-shaped stub there): `(with-open-file (f "x.txt") ...)` hits
  // "Unbound variable `f'" the same way. Doors are procedures, not macros; a
  // genuinely macro-shaped CL/Racket form only fires its door when called with
  // already-bound arguments.
  it("setf / defun fire their door when called with already-bound arguments", async () => {
    const run = await withStubs("well-known-setf-defun-bound-args");
    const setf = await fire(run, "(setf 1 2)");
    expect(setf.door).toBe(true);
    expect(setf.message).toMatch(/in-place mutation/);
    const defun = await fire(run, "(defun 1 2)");
    expect(defun.door).toBe(true);
    expect(defun.message).toMatch(/\(define \(name args \.\.\.\) body \.\.\.\)/);
  });
});

describe("well-known-stubs — the pack upgrades a WALL into a DOOR", () => {
  // The pack ships in BASE_PACKS (base-packs.ts), so the DEFAULT env doors these
  // symbols — the production contract. The wall it replaced is still provable on a
  // bare sandboxed env assembled with NO packs: a bare Unbound variable.
  const cases = [
    ["type-of", "(type-of 5)"],
    ["<>", "(<> 1 2)"],
    ["make-hash", "(make-hash)"],
    ["make-hasheq", "(make-hasheq)"],
    ["hash-ref", '(hash-ref (dict) "a")'],
    ["gethash", '(gethash "a" (dict))'],
    ["getf", "(getf (list 1 2) 1)"],
    ["println", '(println "hi")'],
    ["print", '(print "hi")'],
    ["setf", "(setf 1 2)"],
    ["defun", "(defun 1 2)"],
    ["loop", "(loop)"],
    ["nreverse", "(nreverse (list 1 2 3))"],
    ["for/list", "(for/list)"],
    ["for/fold", "(for/fold)"],
  ] as const;

  for (const [label, src] of cases) {
    it(`${label} doors in the DEFAULT env (the pack ships in BASE_PACKS)`, async () => {
      await expect(exec(src)).rejects.toThrow(/is not available\./);
    });
  }
});
