// tsgo-scale-bench — THE default-backend decision data: js-ts vs tsgo-wasm
// on synthesized arrival programs at growing sizes. The corpus-scale finding
// (js wins ~2× at ~6 lines) is RPC-overhead-dominated; this study measures
// where (whether) the curves cross as the checker does real work.
//
// Run: pnpm research  (needs a tsgo wasm artifact; numbers print via warn).

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSchemeLanguageService, type SchemeLanguageService } from "../language-service.js";
import { getPreludeFiles } from "../prelude.js";
import { spawnTsgoNodeTransport, tsgoWasmAvailable } from "../tsgo/node-transport.js";
import { createTsgoSchemeService, type TsgoSchemeService } from "../tsgo/scheme-service.js";

const wasmPresent = tsgoWasmAvailable();

/** A program with `n` interlinked defines (each references predecessors —
 *  real type-flow, not parallel islands) + a lambda per 4 defines. */
function synth(n: number): string {
  const lines: string[] = [`(define base (list 1 2 3))`];
  for (let i = 0; i < n; i++) {
    const prev = i === 0 ? "base" : `v${i - 1}`;
    lines.push(
      i % 4 === 3 ? `(define (fn${i} x) (+ x (length v${i - 1})))` : `(define v${i} (append ${prev} (list ${i})))`,
    );
  }
  return `${lines.join("\n")}\n`;
}

const POOL = ["car", "cdr", "filter", "map", "list", "cons", "not", "length", "append", "reverse", "base"];

function median(xs: number[]): number {
  const s = xs.toSorted((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
}

describe.skipIf(!wasmPresent)("scale study: js-ts vs tsgo-wasm across program sizes", () => {
  let js: SchemeLanguageService;
  let tsgo: TsgoSchemeService;

  beforeAll(async () => {
    js = createSchemeLanguageService();
    tsgo = await createTsgoSchemeService({ preludeFiles: getPreludeFiles(), transport: spawnTsgoNodeTransport() });
  });

  afterAll(() => {
    tsgo?.dispose();
  });

  it("measures T-gate and diagnostics at 10 / 100 / 400 defines", async () => {
    const ROUNDS = 7;
    const rows: string[] = [];
    for (const n of [10, 100, 400]) {
      const prog = synth(n);
      const slot = `${prog}(car `;
      // warm both once per size
      js.getTypeValidCandidates(slot, slot.length, POOL);
      js.getSemanticDiagnostics(prog);
      await tsgo.getTypeValidCandidates(slot, slot.length, POOL);
      await tsgo.getSemanticDiagnostics(prog);
      const jsT: number[] = [];
      const jsD: number[] = [];
      const goT: number[] = [];
      const goD: number[] = [];
      for (let r = 0; r < ROUNDS; r++) {
        let t = performance.now();
        js.getTypeValidCandidates(slot, slot.length, POOL);
        jsT.push(performance.now() - t);
        t = performance.now();
        js.getSemanticDiagnostics(prog);
        jsD.push(performance.now() - t);
        t = performance.now();
        await tsgo.getTypeValidCandidates(slot, slot.length, POOL);
        goT.push(performance.now() - t);
        t = performance.now();
        await tsgo.getSemanticDiagnostics(prog);
        goD.push(performance.now() - t);
      }
      rows.push(
        `n=${String(n).padStart(3)} (${prog.length}ch): T-gate js ${median(jsT).toFixed(1)}ms vs tsgo ${median(goT).toFixed(1)}ms · diagnostics js ${median(jsD).toFixed(1)}ms vs tsgo ${median(goD).toFixed(1)}ms`,
      );
    }
    console.warn(`[tsgo-scale-bench]\n  ${rows.join("\n  ")}`);
    expect(rows.length).toBe(3);
  });
});
