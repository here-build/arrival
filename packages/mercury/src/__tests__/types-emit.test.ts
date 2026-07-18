/**
 * types-emit — the TYPE-FAITHFUL Scheme→TS emitter for the type lens.
 *
 * Three guards:
 *   1. SNAPSHOT the emitted TS for a handful of small programs (the R6 divergence
 *      guard — any change to the lowering is visible in review).
 *   2. SPAN ROUND-TRIP — a known leaf token's `tsStart` lifts back to the right
 *      `schemeStart`.
 *   3. BITE — compile `PRE + car.d.ts + <emitted program>` through the tsc API and
 *      assert a clean program type-checks while a deliberately-ill `(car 5)` bites.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import tsc from "typescript";
import { describe, expect, it } from "vitest";

import { emitTypes } from "../types-emit.js";

const { dirname, join } = path;

const __dirname = dirname(fileURLToPath(import.meta.url));
// The lens prelude is a sibling package under arrival/packages/. A stale path
// here fails collection with ENOENT, masking every type-plane result.
const LENS_PRELUDE = join(__dirname, "../../../arrival-type-lens/src/prelude");
const PRE = readFileSync(join(LENS_PRELUDE, "types.d.ts"), "utf8");

// Load EVERY builtin leaf that currently exists (the 34-way fan-out lands
// concurrently). The bite tests check emitted programs against whatever leaves
// are present — `car` is guaranteed (the reference leaf); the rest ride along so
// `(list …)`/`(cdr …)`/etc. resolve as they land.
const BUILTINS_DIR = join(LENS_PRELUDE, "builtins");
const LEAVES: { name: string; text: string }[] = readdirSync(BUILTINS_DIR)
  .filter((f) => f.endsWith(".d.ts") && !f.startsWith("_"))
  .map((f) => ({ name: `__leaf_${f}`, text: readFileSync(join(BUILTINS_DIR, f), "utf8") }));

// ── 1. snapshots ────────────────────────────────────────────────────────────

describe("emitTypes — snapshots (R6 divergence guard)", () => {
  it("define (value + function)", () => {
    const { ts } = emitTypes(`(define x 5)\n(define (add a b) (+ a b))`);
    expect(ts).toMatchInlineSnapshot(`
      "const x = 5;
      const add = (a, b) => __arr["+"](a, b);
      export {};
      "
    `);
  });

  it("let → block statement at top level, IIFE only at expression position", () => {
    const { ts } = emitTypes(`(define r (let ((x 1) (y 2)) (+ x y)))\n(let ((a 3)) (* a a))`);
    expect(ts).toMatchInlineSnapshot(`
      "const r = (() => { const x = 1; const y = 2; return __arr["+"](x, y); })();
      { const a = 3; __arr["*"](a, a); };
      export {};
      "
    `);
  });

  it("lambda + map", () => {
    const { ts } = emitTypes(`(define xs (list 1 2 3))\n(define ys (map (lambda (n) (+ n n)) xs))\n(car ys)`);
    expect(ts).toMatchInlineSnapshot(`
      "const xs = __arr.list(1, 2, 3);
      const ys = __arr.map((n) => __arr["+"](n, n), xs);
      __arr.car(ys);
      export {};
      "
    `);
  });

  it("define/overridable — compiles just like an ordinary define, FOR NOW", () => {
    // define/overridable only expands to a real `define` at eval time (arrival/overridable's
    // define-macro); this emitter never expands macros, so it has to recognize the head
    // literally, same as `define`. Before that, the form fell through to a bare call
    // expression — no declaration, nothing for hover/diagnostics to attach to.
    //
    // The type tag (2nd arg) emits as an ordinary bare expression statement ahead of the
    // const — no dedicated type-tag lowering yet, so `x`'s own type still just infers
    // from `default` (last statement). This is enough for the tag to type-check/hover on
    // its own terms: an s/* call resolves against the schema capability's prelude (s/* is
    // the ONLY type vocabulary — never a bare name reference, see the rejection test below).
    const { ts } = emitTypes(`(define/overridable config/product (s/string) "Here.build")`);
    expect(ts).toMatchInlineSnapshot(`
      "sString();
      const configProduct = "Here.build";
      export {};
      "
    `);
  });

  it("define/overridable — an s/* type tag emits as an ordinary call", () => {
    const { ts } = emitTypes(`(define/overridable config/mode (s/enum "fast" "slow") "fast")`);
    expect(ts).toMatchInlineSnapshot(`
      "sEnum("fast", "slow");
      const configMode = "fast";
      export {};
      "
    `);
  });

  it("dict + keyword accessor", () => {
    // A dict is a primitive object, not an alist — it lowers to a DIRECT object
    // literal (`{ name: …, age: … }`), the fast TS path, not a `Dict<Pairs>` mapped
    // remap. Keys use raw keywordName so they match the `(:name row)` index read.
    const { ts } = emitTypes(`(define row (dict :name "alice" :age 30))\n(:name row)`);
    expect(ts).toMatchInlineSnapshot(`
      "const row = { name: "alice", age: 30 };
      (row)["name"];
      export {};
      "
    `);
  });
});

// ── 2. span round-trip ───────────────────────────────────────────────────────

describe("emitTypes — span lens round-trips", () => {
  it("a known leaf token lifts its tsStart back to the right schemeStart", () => {
    // The `5` literal: its scheme offset is index 11 in `(define x 5)`.
    const scheme = `(define x 5)`;
    const schemeFive = scheme.indexOf("5");
    const { ts, mappings } = emitTypes(scheme);
    const tsFive = ts.indexOf("5");

    // Find the mapping whose TS range covers the emitted `5`.
    const hit = mappings.find((e) => e.tsStart <= tsFive && tsFive < e.tsStart + e.tsLength && e.tsLength === 1);
    expect(hit).toBeDefined();
    expect(hit!.schemeStart).toBe(schemeFive);
    expect(hit!.schemeLength).toBe(1);
  });

  it("a string literal lifts back to its source span", () => {
    const scheme = `(define s "hi")`;
    const schemeStr = scheme.indexOf(`"hi"`);
    const { ts, mappings } = emitTypes(scheme);
    const tsStr = ts.indexOf(`"hi"`);
    const hit = mappings.find((e) => e.tsStart === tsStr);
    expect(hit).toBeDefined();
    expect(hit!.schemeStart).toBe(schemeStr);
  });
});

// ── 3. bite (tsc API smoke) ───────────────────────────────────────────────────

/** Compile PRE + car leaf + an emitted program through a bare LanguageService;
 *  return the program file's semantic diagnostics. */
function semanticDiagnostics(emittedTs: string): readonly tsc.Diagnostic[] {
  const files = new Map<string, string>([
    ["__pre.d.ts", PRE],
    ...LEAVES.map((l) => [l.name, l.text] as const),
    ["__prog.ts", emittedTs],
  ]);
  const options: tsc.CompilerOptions = {
    noEmit: true,
    strict: true,
    target: tsc.ScriptTarget.ES2022,
    lib: ["lib.es2022.d.ts"],
    types: [],
    skipLibCheck: false,
  };
  // Mirror the proven probe host: in-memory files first, then the on-disk fallback
  // (so `lib.es2022.d.ts` and friends resolve — without the lib, array types are
  // unknown and `__arr` types loosely, masking every bite).
  const host: tsc.LanguageServiceHost = {
    getScriptFileNames: () => [...files.keys()],
    getScriptVersion: () => "1",
    getScriptSnapshot: (name) => {
      if (files.has(name)) return tsc.ScriptSnapshot.fromString(files.get(name)!);
      const disk = tsc.sys.readFile(name);
      return disk === undefined ? undefined : tsc.ScriptSnapshot.fromString(disk);
    },
    getCurrentDirectory: () => __dirname,
    getCompilationSettings: () => options,
    getDefaultLibFileName: (o) => tsc.getDefaultLibFilePath(o),
    fileExists: (name) => files.has(name) || tsc.sys.fileExists(name),
    readFile: (name) => (files.has(name) ? files.get(name) : tsc.sys.readFile(name)),
  };
  const svc = tsc.createLanguageService(host, tsc.createDocumentRegistry());
  return svc.getSemanticDiagnostics("__prog.ts");
}

describe("emitTypes — bites under tsc against the type-lens prelude", () => {
  it("a clean (car <list>) program type-checks with no diagnostics", () => {
    const { ts: emitted, droppedForms } = emitTypes(`(define xs (list 1 2 3))\n(define h (car xs))`);
    expect(droppedForms).toEqual([]);
    expect(semanticDiagnostics(emitted)).toEqual([]);
  });

  it("an ill (car 5) program produces a diagnostic", () => {
    const { ts: emitted } = emitTypes(`(define z (car 5))`);
    const diags = semanticDiagnostics(emitted);
    expect(diags.length).toBeGreaterThan(0);
  });

  it("the (car 5) diagnostic's TS span lifts back onto the `5` in scheme", () => {
    const scheme = `(define z (car 5))`;
    const { ts: emitted, mappings } = emitTypes(scheme);
    const diags = semanticDiagnostics(emitted);
    expect(diags.length).toBeGreaterThan(0);
    const d = diags[0]!;
    // The diagnostic lands on the emitted `5`; lift it through the span map.
    const covering = mappings.find(
      (m) => d.start !== undefined && m.tsStart <= d.start && d.start < m.tsStart + m.tsLength,
    );
    expect(covering).toBeDefined();
    // The covered scheme offset is the `5` argument to car.
    const schemeText = scheme.slice(covering!.schemeStart, covering!.schemeStart + covering!.schemeLength);
    expect(schemeText).toBe("5");
  });

  it("a bare-name define/overridable type tag bites — name types are prohibited, only s/*", () => {
    // s/* (s/enum, s/object, …) and the bare primitive strings are the ONLY type
    // vocabulary — there is no "reference some other name as a type" form. Emitting
    // the tag as an ordinary expression (rather than inventing a name-as-type lookup)
    // is what makes this the correct, structural rejection: `NotARealType` is simply
    // an unresolved identifier, exactly like any other free reference would bite.
    const { ts: emitted } = emitTypes(`(define/overridable x NotARealType "default")`);
    const diags = semanticDiagnostics(emitted);
    expect(diags.length).toBeGreaterThan(0);
  });
});

// ── failure isolation ─────────────────────────────────────────────────────────

describe("emitTypes — per-form failure isolation + module scope", () => {
  it("emits a module footer so top-level consts are module-scoped", () => {
    const { ts } = emitTypes(`(define x 1)`);
    expect(ts).toContain("export {};");
  });

  it("never throws on an unsupported form, degrading it to unknown", () => {
    // `case` doors in desugar (throws) — the whole-program parse fails gracefully
    // to an empty module rather than throwing.
    expect(() => emitTypes(`(define x (case y ((1) "a")))`)).not.toThrow();
  });
});

// ── declaredNames — backporting emitted identifiers to their original scheme spelling ──
// `cleanName` (names.ts) is LOSSY/many-to-one (predicate markers ?!* are stripped, not
// encoded; `config/audience`, `config-audience`, `config_audience` all collapse to the
// SAME `configAudience`), so a pure inverse function is impossible in general. Instead
// emitTypes tracks the mapping AT THE POINT each name is minted, so a consumer (the
// completion source) can look up the real scheme text a completion candidate came from —
// the "unidirectional conversion" bug: autocomplete showed `configAudience`, not the
// `config/audience` the user actually typed.
describe("emitTypes — declaredNames (backporting emitted identifiers to their scheme source spelling)", () => {
  it("maps a slash-bearing define name back to its original scheme spelling", () => {
    const { declaredNames } = emitTypes(`(define config/audience "people")`);
    expect(declaredNames.get("configAudience")).toBe("config/audience");
  });

  it("maps a define/overridable name back to its original scheme spelling", () => {
    const { declaredNames } = emitTypes(`(define/overridable config/model "string" "qwen")`);
    expect(declaredNames.get("configModel")).toBe("config/model");
  });

  it("an already-identifier-safe name maps to itself (fixed point, still present in the table)", () => {
    const { declaredNames } = emitTypes(`(define plain 1)`);
    expect(declaredNames.get("plain")).toBe("plain");
  });

  it("the (define (f a b) body) sugar maps the function name too", () => {
    const { declaredNames } = emitTypes(`(define (config/get-model) "qwen")`);
    expect(declaredNames.get("configGetModel")).toBe("config/get-model");
  });

  it("multiple defines each get their own entry", () => {
    const { declaredNames } = emitTypes(`(define config/a 1)\n(define config/b 2)`);
    expect(declaredNames.get("configA")).toBe("config/a");
    expect(declaredNames.get("configB")).toBe("config/b");
  });
});
