// tsgo-equivalence — the AB canary for the tsgo (TypeScript 7 wasm) backend:
// Layer T verdicts from the tsgo checker API must MATCH the JS-TS probe
// machinery on the same corpus (language-service.test.ts's Layer-T rows).
// Equality here is the proof that swapping `[T] extends [E]` probe programs
// for direct `isTypeAssignableTo` reads preserved the mask's semantics.
//
// Needs the locally-built wasm artifact (.tsgo/tsgo.wasm — gitignored):
//   node scripts/build-tsgo-wasm.mjs   (requires a Go toolchain)
// Absent artifact ⇒ the suite SKIPS LOUDLY (a visible console.warn, not a
// silent green) — promote to a hard gate once the artifact story is settled.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assembleHostPrelude } from "../host-prelude.js";
import { createSchemeLanguageService, type SchemeLanguageService } from "../language-service.js";
import { getPreludeFiles } from "../prelude.js";
import { spawnTsgoNodeTransport, tsgoWasmAvailable } from "../tsgo/node-transport.js";
import { createTsgoTypeLens, scanInnermostCall, type TsgoTypeLens } from "../tsgo/type-lens.js";

// A typed enum prelude shared by the literal-narrowing equivalence row: the
// JS-TS lens consumes it as a `host`; the tsgo lens needs the same leaf merged
// into its `preludeFiles` (the tsgo lens derives its member roster from the
// merged ArrShape, so adding the leaf narrows both slot and candidate sides).
const ENUM_HOST = assembleHostPrelude(
  [
    ["book_table", "(cuisine: T_book_cuisine): SStr"],
    ["thai", ": T_book_cuisine"],
    ["italian", ": T_book_cuisine"],
    ["mexican", ": T_book_cuisine"],
  ],
  { preamble: `type T_book_cuisine = "thai" | "italian" | "mexican";` },
);
/** The base prelude files + the enum host leaf, for the tsgo lens. */
function enumPreludeFiles(): Map<string, string> {
  const files = getPreludeFiles();
  files.set("__host.d.ts", ENUM_HOST.prelude);
  return files;
}

const wasmPresent = tsgoWasmAvailable();
if (!wasmPresent) {
  console.warn(
    "[tsgo-equivalence] SKIPPED — .tsgo/tsgo.wasm not built. Run `node scripts/build-tsgo-wasm.mjs` (needs Go).",
  );
}

describe("scanInnermostCall — the scheme-side call-slot scanner (pure)", () => {
  it("finds the callee and argument index at simple slots", () => {
    expect(scanInnermostCall("(car ")).toEqual({ callee: "car", argIndex: 0 });
    expect(scanInnermostCall("(+ 1 ")).toEqual({ callee: "+", argIndex: 1 });
    expect(scanInnermostCall("(filter ")).toEqual({ callee: "filter", argIndex: 0 });
  });

  it("reports null at operator position and top level", () => {
    expect(scanInnermostCall("(")).toBeNull();
    expect(scanInnermostCall("")).toBeNull();
    expect(scanInnermostCall("(ca")).toBeNull(); // typing the head
  });

  it("a partial atom occupies its slot uncounted (stripped semantics)", () => {
    expect(scanInnermostCall("(car fi")).toEqual({ callee: "car", argIndex: 0 });
    expect(scanInnermostCall("(+ 1 le")).toEqual({ callee: "+", argIndex: 1 });
  });

  it("nested forms count as one item; the innermost open call wins", () => {
    expect(scanInnermostCall("(cons (car xs) ")).toEqual({ callee: "cons", argIndex: 1 });
    expect(scanInnermostCall("(filter (lambda (x) (> x ")).toEqual({ callee: ">", argIndex: 1 });
  });

  it("strings, comments and char literals are lexed, not parsed into items", () => {
    expect(scanInnermostCall('(string-append "a (b" ')).toEqual({ callee: "string-append", argIndex: 1 });
    expect(scanInnermostCall("(car ; comment (ignored\n")).toEqual({ callee: "car", argIndex: 0 });
    expect(scanInnermostCall(String.raw`(cons #\( `)).toEqual({ callee: "cons", argIndex: 1 });
  });
});

describe.skipIf(!wasmPresent)("tsgo Layer T ≡ JS-TS Layer T (the AB canary)", () => {
  const POOL = ["car", "cdr", "filter", "map", "list", "cons", "not", "length"];
  let jsLens: SchemeLanguageService;
  let tsgoLens: TsgoTypeLens | undefined;

  beforeAll(async () => {
    jsLens = createSchemeLanguageService();
    tsgoLens = await createTsgoTypeLens({
      preludeFiles: getPreludeFiles(),
      transport: spawnTsgoNodeTransport(),
    });
  }, 60_000);

  afterAll(() => {
    tsgoLens?.dispose();
  });

  /** Run both backends on one corpus row and require identical verdict sets. */
  async function verdictsAgree(scheme: string, offset: number, pool: readonly string[]): Promise<Set<string>> {
    const js = new Set(jsLens.getTypeValidCandidates(scheme, offset, pool));
    const tsgo = new Set(await tsgoLens!.getTypeValidCandidates(scheme, offset, pool));
    expect(tsgo).toEqual(js);
    return tsgo;
  }

  it("argument slots narrow identically on the hand corpus", { timeout: 60_000 }, async () => {
    const carArg = await verdictsAgree("(car ", 5, POOL);
    expect(carArg.has("list")).toBe(true); // list-producer survives
    expect(carArg.has("filter")).toBe(true); // returns a list
    expect(carArg.has("car")).toBe(false); // element, not list
    expect(carArg.has("length")).toBe(false); // number
    expect(carArg.has("not")).toBe(false); // bool

    const plusArg = await verdictsAgree("(+ 1 ", 5, POOL);
    expect(plusArg.has("length")).toBe(true); // number-producer
    expect(plusArg.has("list")).toBe(false);

    const predArg = await verdictsAgree("(filter ", 8, POOL);
    expect(predArg.has("not")).toBe(true); // predicate-shaped
    expect(predArg.has("list")).toBe(false);
  });

  it("narrows the FULL roster without truncation loss, same as element-wise probes", { timeout: 120_000 }, async () => {
    const pool = jsLens.getCompletionsAtPosition("(car ", 5).map((e) => e.name);
    expect(pool.length).toBeGreaterThan(50);
    const narrowed = await verdictsAgree("(car ", 5, pool);
    expect(narrowed.size).toBeLessThan(pool.length / 2);
    expect(narrowed.has("list")).toBe(true);
    expect(narrowed.has("odd?")).toBe(false);
    expect(narrowed.has("string-append")).toBe(false);
  });

  it("does not narrow at operator/top positions", { timeout: 60_000 }, async () => {
    const atOperator = await verdictsAgree("(", 1, POOL);
    expect(atOperator.size).toBe(POOL.length);
    const atTop = await verdictsAgree("", 0, POOL);
    expect(atTop.size).toBe(POOL.length);
  });

  it("keeps unresolved candidates (never a false drop)", { timeout: 60_000 }, async () => {
    const valid = await verdictsAgree("(+ 1 ", 5, ["netscan", "length", "list"]);
    expect(valid.has("netscan")).toBe(true);
    expect(valid.has("length")).toBe(true);
    expect(valid.has("list")).toBe(false);
  });

  it("empty pool and unbalanced prefixes are safe", { timeout: 60_000 }, async () => {
    expect(await tsgoLens!.getTypeValidCandidates("(car ", 5, [])).toEqual([]);
    await expect(tsgoLens!.getTypeValidCandidates("(filter (lambda (x) (> x ", 25, POOL)).resolves.toBeDefined();
  });

  it("string-literal candidates narrow IDENTICALLY at an enum-union slot", { timeout: 60_000 }, async () => {
    // The literal-narrowing fix (a quoted string `"thai"` interpolated AS the
    // literal type) must produce the same verdicts on both backends — same
    // shared `stringLiteralType` + identical `typeofRef` body.
    const ENUM_POOL = ['"thai"', '"italian"', '"vegan"', '"nonsense"', "thai", "italian"];
    const jsEnum = createSchemeLanguageService({ host: ENUM_HOST });
    const tsgoEnum = await createTsgoTypeLens({
      preludeFiles: enumPreludeFiles(),
      transport: spawnTsgoNodeTransport(),
    });
    try {
      const js = new Set(jsEnum.getTypeValidCandidates("(book_table )", "(book_table ".length, ENUM_POOL));
      const tsgo = new Set(await tsgoEnum.getTypeValidCandidates("(book_table )", "(book_table ".length, ENUM_POOL));
      expect(tsgo).toEqual(js);
      // and the verdict is the right one (the gap was: every literal kept-blind)
      expect(tsgo.has('"thai"')).toBe(true); // a member
      expect(tsgo.has('"vegan"')).toBe(false); // wrong-enum literal → dropped
      expect(tsgo.has('"nonsense"')).toBe(false); // non-member literal → dropped
      expect(tsgo.has("thai")).toBe(true); // bound typed symbol → kept (production path)
    } finally {
      tsgoEnum.dispose();
    }
  });

  it("perf note: per-slot narrowing cost, tsgo vs js", { timeout: 60_000 }, async () => {
    const ROUNDS = 10;
    const t0 = performance.now();
    for (let i = 0; i < ROUNDS; i++) {
      await tsgoLens!.getTypeValidCandidates(`(car `, 5, POOL);
    }
    const tsgoPerSlot = (performance.now() - t0) / ROUNDS;
    const t1 = performance.now();
    for (let i = 0; i < ROUNDS; i++) {
      jsLens.getTypeValidCandidates(`(car `, 5, POOL);
    }
    const jsPerSlot = (performance.now() - t1) / ROUNDS;
    // The js-ts DIAGNOSTICS loop on the same world — the IDE's per-keystroke
    // cost, the number the spike's tsgo edit+diagnostics 2.6ms compares to.
    const t2 = performance.now();
    for (let i = 0; i < ROUNDS; i++) {
      jsLens.getSemanticDiagnostics(`(car (list 1 2 ${i}))`);
    }
    const jsDiag = (performance.now() - t2) / ROUNDS;
    // warn, not log: run with --disable-console-intercept to see it
    console.warn(
      `[tsgo-equivalence] per-slot getTypeValidCandidates (8 candidates): tsgo-wasm ${tsgoPerSlot.toFixed(1)}ms vs js-ts ${jsPerSlot.toFixed(1)}ms; js-ts per-edit getSemanticDiagnostics ${jsDiag.toFixed(1)}ms (tsgo spike: 2.6ms)`,
    );
    expect(tsgoPerSlot).toBeLessThan(500);
  });
});
