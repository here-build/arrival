/**
 * §9 enforcement-spine item, minimal form: **`tsc --strict` on emitted output**
 * (constitution §1 surface 2 — "the emitted project must pass `tsc --strict` …
 * a *consequence* check: if residuals and annotations are honest it passes; a
 * failure means a law was broken upstream").
 *
 * Renders corpus programs through the FULL greenfield pipeline
 * (`compileGreenfield` — the exact bytes the oracle's gate subject executes)
 * and typechecks the emitted text with a programmatic in-memory
 * `ts.createProgram` against the real es2022 lib (the async-ify.test.ts
 * precedent — no temp files, no shell-out). The emitted module's
 * `./stage0.mts` import resolves to the REAL stage-0 runtime source mapped
 * into the in-memory host, so shim signatures participate in the check —
 * emitted call sites are typechecked against the actual runtime module, not a
 * declared stand-in.
 *
 * `noImplicitAny: false` mirrors the async-ify gate: walker params are
 * unannotated by design this wave; inference still types the bodies, so
 * structural errors (bad member access, wrong arg counts, unresolved imports)
 * keep teeth.
 *
 * SUBJECTS are corpus rows whose emitted artifacts are strict-clean TODAY
 * (probe-measured 2026-07-14: 23 of 34 rows clean). The two failing classes
 * are documented, not hidden (Law F's "never wrong, always visible" applied to
 * the gate itself):
 *
 *  - TS2367 (9 rows): Law T's run-side guard `c !== false` where tsc KNOWS `c`
 *    is never boolean (literals, `unknown[]`, strings) — semantically correct
 *    Scheme truthiness that TS flags as a suspicious comparison; the widen is
 *    the same hazard class phase1.ts's header defers to a later wave.
 *  - TS2345/TS18046 (4 rows: any-witness, apply-plus, every-boolean-pred,
 *    multi-list-map): `unknown`-element shim results (`list` → `unknown[]`)
 *    meeting number-typed shim params (`plus`, `gt`, `odd?`) or arithmetic —
 *    the shim-boundary precision the types track's instantiated-signature
 *    facts exist to close.
 *
 * Growing SUBJECTS toward "every corpus row" IS the enforcement spine's
 * build-out; shrinking it is a red flag.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { compileGreenfield, openOracleSession } from "../index.js";
import type { OracleSession } from "../index.js";

const corpusDir = fileURLToPath(new URL("corpus/", import.meta.url));
const read = (name: string): string => readFileSync(`${corpusDir}${name}.scm`, "utf8");

/** The REAL runtime module source, mapped at the emitted import's resolution
 *  target — the gate must typecheck emitted call sites against the shims they
 *  actually call (a `declare` stand-in would let signature drift through). */
const stage0Source = readFileSync(fileURLToPath(new URL("../runtime/stage0.ts", import.meta.url)), "utf8");

/** Virtual files live at REAL-directory paths: bundler-mode resolution consults
 *  `host.directoryExists`, which `createCompilerHost` answers from the actual
 *  filesystem — a fabricated root (`/gate/…`) fails resolution with TS2307
 *  before `fileExists` is ever asked (probe-verified). The directory is real;
 *  the files are virtual (served by the host overrides below). */
const VIRTUAL_DIR = fileURLToPath(new URL(".", import.meta.url));
const MAIN_FILE = `${VIRTUAL_DIR}__virtual-gate-case__.mts`;
const STAGE0_FILE = `${VIRTUAL_DIR}stage0.mts`; // where `./stage0.mts` in MAIN_FILE resolves

/** Typecheck one emitted module against the real es2022 lib + the real stage-0
 *  runtime, fully in-memory (typescript@6.0.2 from this package's own deps). */
function strictDiagnostics(emitted: string): readonly string[] {
  const files = new Map([
    [MAIN_FILE, emitted],
    [STAGE0_FILE, stage0Source],
  ]);
  const options: ts.CompilerOptions = {
    strict: true,
    noImplicitAny: false,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true, // `./stage0.mts` — extensioned TS import, noEmit
    lib: ["lib.es2022.d.ts"],
    types: [],
    noEmit: true,
    skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options, true);
  const baseFileExists = host.fileExists.bind(host);
  const baseReadFile = host.readFile.bind(host);
  const baseGetSourceFile = host.getSourceFile.bind(host);
  host.fileExists = (f) => files.has(f) || baseFileExists(f);
  host.readFile = (f) => files.get(f) ?? baseReadFile(f);
  host.getSourceFile = (f, languageVersion, onError, shouldCreateNew) =>
    files.has(f)
      ? ts.createSourceFile(f, files.get(f)!, ts.ScriptTarget.ES2022, true)
      : baseGetSourceFile(f, languageVersion, onError, shouldCreateNew);
  const program = ts.createProgram([MAIN_FILE], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`);
}

/** Strict-clean corpus rows (see header). Distinct emit paths on purpose:
 *  `quotient-neg` (a numeric emit rule minting a global-`Math` residual),
 *  `member-assoc` (the FRAME import path — three rung-3 shims typechecked
 *  against the real stage-0 signatures), and `or-in-define` (engine forms:
 *  DefineFn + the guarded and/or cascade over any-typed params + a call). */
const SUBJECTS = ["quotient-neg", "member-assoc", "or-in-define"] as const;

describe("emitted output passes tsc --strict (§9 enforcement spine, minimal form)", () => {
  let session: OracleSession;
  beforeAll(async () => {
    session = await openOracleSession();
  }, 120_000);
  afterAll(async () => {
    await session.dispose();
  });

  for (const name of SUBJECTS) {
    it(
      `${name} — zero diagnostics`,
      () => {
        expect(strictDiagnostics(compileGreenfield(session, read(name)))).toEqual([]);
      },
      120_000,
    );
  }

  it("negative control: a type-broken module FAILS the same check", () => {
    expect(strictDiagnostics(`const n: number = "not a number";\nexport const __oracleResult = n;\n`)).not.toEqual([]);
  });
});
