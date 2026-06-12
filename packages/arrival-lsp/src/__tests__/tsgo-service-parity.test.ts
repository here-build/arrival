// tsgo-service-parity — the AB canary for the FULL scheme service over tsgo:
// each of the seven methods compared against the JS-TS service-core on a
// shared corpus. Exact where the contract is exact (diagnostic codes/spans/
// severities, definition spans, completion name-sets, T-gate verdicts);
// structural where divergence is documented in scheme-service.ts's header
// (hover text shape, classification coverage).
//
// Needs a tsgo wasm artifact (npm tsgo-wasm or .tsgo/) — loud-skips otherwise.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createSchemeLanguageService, type SchemeLanguageService } from "../language-service.js";
import { getPreludeFiles } from "../prelude.js";
import { spawnTsgoNodeTransport, tsgoWasmAvailable } from "../tsgo/node-transport.js";
import { createTsgoSchemeService, type TsgoSchemeService } from "../tsgo/scheme-service.js";

const wasmPresent = tsgoWasmAvailable();
if (!wasmPresent) {
  console.warn("[tsgo-service-parity] SKIPPED — no tsgo wasm artifact (install tsgo-wasm or build .tsgo/).");
}

const diagKey = (d: { code: number; start: number; length: number; severity: string }): string =>
  `${d.code}@${d.start}+${d.length}:${d.severity}`;
const byKey = (a: string, b: string): number => a.localeCompare(b);

const PROG = `(define names (list "ada" "grace" "hedy"))
(define total (length names))
(define (greet name) (string-append "dr " name))
(define double (lambda (n) (* n 2)))
(map double (list 1 2 3))
`;

describe.skipIf(!wasmPresent)("tsgo scheme-service ≡ JS-TS service-core", () => {
  let js: SchemeLanguageService;
  let tsgo: TsgoSchemeService;

  beforeAll(async () => {
    js = createSchemeLanguageService();
    tsgo = await createTsgoSchemeService({ preludeFiles: getPreludeFiles(), transport: spawnTsgoNodeTransport() });
  }, 60_000);

  afterAll(() => {
    tsgo?.dispose();
  });

  it("diagnostics agree on codes, spans and severities", { timeout: 60_000 }, async () => {
    // One real type error + one unknown free name (the 2304→suggestion rewrite).
    const bad = `${PROG}(car 5)\n(frobnicate names)\n`;
    const jsDiags = js
      .getSemanticDiagnostics(bad)
      .map((d) => ({ code: d.code, start: d.start, length: d.length, severity: d.severity }));
    const tsgoRaw = await tsgo.getSemanticDiagnostics(bad);
    const tsgoDiags = tsgoRaw.map((d) => ({ code: d.code, start: d.start, length: d.length, severity: d.severity }));
    expect(tsgoDiags.map(diagKey).toSorted(byKey)).toEqual(jsDiags.map(diagKey).toSorted(byKey));
  });

  it("clean programs are clean on both", { timeout: 60_000 }, async () => {
    expect(js.getSemanticDiagnostics(PROG).filter((d) => d.severity === "error")).toEqual([]);
    const tsgoClean = await tsgo.getSemanticDiagnostics(PROG);
    expect(tsgoClean.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("hover renders the same type for a local", { timeout: 60_000 }, async () => {
    const at = PROG.indexOf("names)"); // the `names` use inside (length names)
    const jsInfo = js.getQuickInfoAtPosition(PROG, at);
    const tsgoInfo = await tsgo.getQuickInfoAtPosition(PROG, at);
    expect(jsInfo).not.toBeNull();
    expect(tsgoInfo).not.toBeNull();
    // js renders displayParts (`const names: List<SStr>`), tsgo `names: <type>` —
    // the TYPE is the contract.
    const colon = jsInfo!.displayText.indexOf(": ");
    expect(colon).toBeGreaterThan(-1);
    const jsType = jsInfo!.displayText.slice(colon + 2);
    expect(tsgoInfo!.displayText).toContain(jsType);
    expect(tsgoInfo!.span).not.toBeNull();
  });

  it(
    "hover on a builtin carries its signature (docs: both dry — no leaf has JSDoc yet)",
    { timeout: 60_000 },
    async () => {
      const at = PROG.indexOf("string-append") + 3;
      const info = await tsgo.getQuickInfoAtPosition(PROG, at);
      expect(info).not.toBeNull();
      expect(info!.displayText).toContain("=>");
      // The doc channel is wired (leaf JSDoc → hover) but no builtin leaf is
      // documented today — parity with the JS side is the empty string.
      expect(info!.documentation).toBe(js.getQuickInfoAtPosition(PROG, at)?.documentation ?? "");
    },
  );

  it("completions offer the same name set", { timeout: 60_000 }, async () => {
    // A realistic query: mid-typing an operator atom (the IDE always asks at
    // an atom, never at bare EOF whitespace — where service-core answers []).
    const typing = `${PROG}(ca`;
    const offset = typing.length;
    const jsNames = new Set(js.getCompletionsAtPosition(typing, offset).map((e) => e.name));
    const tsgoEntries = await tsgo.getCompletionsAtPosition(typing, offset);
    const tsgoNames = new Set(tsgoEntries.map((e) => e.name));
    expect(tsgoNames).toEqual(jsNames);
  });

  it("completions include enclosing lambda params (scope-aware)", { timeout: 60_000 }, async () => {
    const inBody = PROG.indexOf('(string-append "dr " name)') + 1;
    const inScope = await tsgo.getCompletionsAtPosition(PROG, inBody);
    expect(new Set(inScope.map((e) => e.name)).has("name")).toBe(true); // greet's param, in scope here
    const topEntries = await tsgo.getCompletionsAtPosition(PROG, PROG.length);
    expect(new Set(topEntries.map((e) => e.name)).has("name")).toBe(false); // out of scope at top level
  });

  it("go-to-definition lands on the same binding form", { timeout: 60_000 }, async () => {
    const use = PROG.lastIndexOf("double"); // the use in (map double …)
    const jsDefs = js.getDefinitionAtPosition(PROG, use);
    const tsgoDefs = await tsgo.getDefinitionAtPosition(PROG, use);
    expect(jsDefs.length).toBeGreaterThan(0);
    expect(tsgoDefs.length).toBeGreaterThan(0);
    expect(tsgoDefs[0]!.span).toEqual(jsDefs[0]!.span);
    // Builtins answer span:null on both.
    const carUse = `${PROG}(car names)\n`;
    const jsCar = js.getDefinitionAtPosition(carUse, carUse.indexOf("car ") + 1);
    const tsgoCar = await tsgo.getDefinitionAtPosition(carUse, carUse.indexOf("car ") + 1);
    expect(jsCar[0]?.span ?? null).toBeNull();
    expect(tsgoCar[0]?.span ?? null).toBeNull();
  });

  it("semantic classifications agree where both classify", { timeout: 60_000 }, async () => {
    const jsSpans = js.getSemanticClassifications(PROG);
    const tsgoSpans = await tsgo.getSemanticClassifications(PROG);
    const index = new Map(tsgoSpans.map((s) => [`${s.start}+${s.length}`, s.kind]));
    let compared = 0;
    for (const s of jsSpans) {
      const kind = index.get(`${s.start}+${s.length}`);
      if (kind === undefined) continue;
      expect(`${s.start}+${s.length}:${kind}`).toBe(`${s.start}+${s.length}:${s.kind}`);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(2); // overlap must be real, not vacuous
  });

  it("completion context: position, slot card and fits at an argument slot", { timeout: 60_000 }, async () => {
    const argSlot = `${PROG}(map double `;
    const jsCtx = js.getCompletionContext(argSlot, argSlot.length);
    const tsgoCtx = await tsgo.getCompletionContext(argSlot, argSlot.length);
    expect(tsgoCtx.position).toBe(jsCtx.position);
    expect(tsgoCtx.slot?.callee).toBe(jsCtx.slot?.callee);
    expect(tsgoCtx.slot?.argIndex).toBe(jsCtx.slot?.argIndex);
    // fits verdicts agree wherever BOTH backends issue one for the same entry.
    const jsFits = new Map(jsCtx.entries.filter((e) => e.fits !== undefined).map((e) => [e.name, e.fits]));
    let compared = 0;
    for (const e of tsgoCtx.entries) {
      if (e.fits === undefined || !jsFits.has(e.name)) continue;
      expect(`${e.name}:${e.fits}`).toBe(`${e.name}:${jsFits.get(e.name)}`);
      compared += 1;
    }
    expect(compared).toBeGreaterThan(5);
    // operator position reported identically
    const opCtx = await tsgo.getCompletionContext(`${PROG}(`, PROG.length + 1);
    expect(opCtx.position).toBe(js.getCompletionContext(`${PROG}(`, PROG.length + 1).position);
  });
});
