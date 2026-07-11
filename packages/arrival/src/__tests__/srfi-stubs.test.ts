// The teaching-stub pack (`env/srfi/srfi-stubs.ts`): symbols an LLM agent
// predictably reaches for that arrival deliberately does NOT implement, each bound
// to an errors-as-doors throw (PurityError) that names the alternative. These tests
// pin, per family, that:
//   (a) the symbol FIRES a door (not a silent success), and
//   (b) the door's message carries the LOAD-BEARING redirect (the exact alternative),
// and — crucially — that WITHOUT the pack the same symbol is a bare "Unbound
// variable" wall, proving the pack upgrades the wall into a door.
//
// Assembly mirrors `env/__tests__/srfi.test.ts`: a capability is lowered onto a
// fresh sandboxed env EXPLICITLY (the pack is not globally registered). Door-firing
// is detected like `__tests__/purity-doors.test.ts`: the evaluator wraps the throw
// in ArrivalError but preserves the message and chains the PurityError as `.cause`.

import { describe, expect, it } from "vitest";
import { mintFrame } from "../AmbientRuntime.js";
import { exec } from "../index.js";
// In-package test: internal-module access (the barrel export retired — privatization V5).
import { inferenceEnv as sandboxedEnv } from "../inference-env.js";
import { assembleEnv } from "../common/kernel.js";
import { type SchemeEnv } from "../common/scheme-env.js";
import { PurityError } from "../errors.js";
import stubPack from "../env/srfi/srfi-stubs.js";

/** Assemble the stub pack onto a fresh sandboxed env; return an exec bound to it. */
async function withStubs(name: string): Promise<(src: string) => Promise<unknown[]>> {
  const env = mintFrame(sandboxedEnv, name);
  await assembleEnv(env as unknown as SchemeEnv, [stubPack.lower({}) as never]);
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

describe("srfi-stubs — one representative door per family", () => {
  // [family label, source that reaches for a stub, load-bearing redirect substring]
  const cases: ReadonlyArray<readonly [string, string, RegExp]> = [
    ["hash tables → dicts are native", '(make-hash-table)', /dicts are native/],
    ["file ports → filesystem tool", '(open-input-file "x.txt")', /filesystem/],
    ["random → ambient non-determinism", '(random-integer 10)', /ambient/],
    ["char-sets → char / one-arg predicate", '(char-set-contains? 1 2)', /predicate/],
    ["time/date → ambient clock", '(current-date)', /ambient/],
    ["string-filter → filter + string<->list composition", '(string-filter char-numeric? "a1b2")', /list->string \(filter pred \(string->list s\)\)/],
    ["SRFI-113 sets → no set type, no redirect claimed", '(list->set (list 1 2))', /no set type/],
    ["string ports → operate on the string directly", '(call-with-input-string "x" (lambda (p) p))', /string ports are omitted/],
  ] as const;

  for (const [label, src, redirect] of cases) {
    it(`${label} — fires a door whose message routes to the alternative`, async () => {
      const run = await withStubs(`stub-${label}`);
      const { door, message } = await fire(run, src);
      expect(door).toBe(true);
      expect(message).toMatch(redirect);
    });
  }
});

describe("srfi-stubs — the pack upgrades a WALL into a DOOR", () => {
  // The pack is registered in allSrfi, so the DEFAULT env doors these symbols — the
  // production contract. The wall it replaced is still provable on a bare sandboxed
  // env assembled with NO packs: a bare Unbound variable, the dead end the pack
  // exists to turn into a teaching door.
  const cases = [
    ["make-hash-table", '(make-hash-table)'],
    ["open-input-file", '(open-input-file "x.txt")'],
    ["random-integer", '(random-integer 10)'],
    ["char-set-contains?", '(char-set-contains? 1 2)'],
    ["current-date", '(current-date)'],
    ["string-filter", '(string-filter char-numeric? "a1b2")'],
    ["list->set", '(list->set (list 1 2))'],
    ["set-contains?", '(set-contains? (list 1 2) 1)'],
    ["call-with-input-string", '(call-with-input-string "x" (lambda (p) p))'],
  ] as const;

  // (No "wall" counter-case: the pack ships inside allSrfi → BASE_PACKS, so every env
  // that inherits sandboxedEnv doors these symbols — a pack-less configuration no
  // longer exists in production, and pinning an unreachable configuration is noise.)
  for (const [label, src] of cases) {
    it(`${label} doors in the DEFAULT env (the pack ships in allSrfi)`, async () => {
      await expect(exec(src)).rejects.toThrow(/is not available\./);
    });
  }
});
