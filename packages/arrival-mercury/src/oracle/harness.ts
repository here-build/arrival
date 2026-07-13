/**
 * The differential oracle's core (oracle-harness.md §2/§4.1): does `source.scm`
 * evaluate to the same observable value under the arrival interpreter and under
 * `run(compile(source, { target: "run" }))`? Implementation-oblivious and
 * execution-only — it never inspects mercury's internals, and the only view it
 * takes of either world is source-in / JS-face-value-out.
 *
 * Interpreter side: ONE `buildArrivalSession` (the expensive capability-DAG
 * assembly) reused across rows; a FRESH `LexicalScope` per program with
 * `BUILTIN_PREAMBLE` re-executed into it, so program N's defines never leak
 * into program N+1 (spec §4.1, edge §5.6). Mirrors `runProgram`'s own per-form
 * loop (`run-program.ts:461-479`): `execState` per parsed top-level form,
 * thenable-await, `schemeToJs` at the exit.
 *
 * Compiled side: `projectToJsRaw(source, { target: "run", strategy })` — raw
 * (format-free `assemble` output) on purpose: each top-level form is one
 * `\n\n`-separated chunk, so the trailing expression is recoverable without
 * fighting prettier's line-splitting. The trailing chunk is rewritten to
 * `export const __oracleResult = <expr>;` (the exporting twin of
 * `compile-project.ts::printEntryResult` — no stdout/JSON round-trip, so
 * `NaN`/`-0` survive), written to a scratch `.mts` INSIDE this package tree
 * (Node bare-specifier resolution walks up for `node_modules`; `os.tmpdir()`
 * never finds the workspace), and executed in-process via tsx's `tsImport`.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, rmdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { execState, LexicalScope, parseGenerator, schemeToJsUntyped } from "@here.build/arrival";
import type { AssembledAmbient } from "@here.build/arrival/env";
import { buildArrivalSession, BUILTIN_PREAMBLE, type InferFn } from "@inhuman.tools/arrival-run";
import { DEFAULT_STRATEGY, projectToJsRaw, type Strategy } from "@inhuman.tools/mercury";
import { tsImport } from "tsx/esm/api";

import { classifyCompiledError, classifyInterpreterError, type ErrorClass } from "./error-classifier.js";

/** The expensive, reusable half of a differential run — one capability-DAG
 *  assembly, held across many corpus/fuzz iterations (spec §4.1). */
export interface OracleSession extends AsyncDisposable {
  readonly ambient: AssembledAmbient;
  dispose(): Promise<void>;
}

/**
 * Build the one shared interpreter session. No `loader` is passed — every
 * corpus/fuzz program is a self-contained snippet, so `(require …)` stays an
 * unbound symbol by capability withholding. `infer` is the required non-thunk
 * `InferFn` callback (`BuildArrivalEnvOpts.infer`); the stub keeps `(infer …)`
 * a BOUND symbol that fails loudly, never an "unbound variable" red herring.
 */
export async function openOracleSession(): Promise<OracleSession> {
  const infer: InferFn = () => {
    throw new Error("oracle: (infer …) not supported outside the async-family cell");
  };
  const session = await buildArrivalSession({ name: "arrival-mercury-oracle", infer, params: {} });
  const dispose = (): Promise<void> => session.dispose();
  return { ambient: session.ambient, dispose, [Symbol.asyncDispose]: dispose };
}

export type Outcome =
  | { kind: "value"; value: unknown } // membrane JS face, both sides
  | { kind: "throw"; errorClass: ErrorClass; message: string; raw: unknown };

const isThenable = (v: unknown): v is PromiseLike<unknown> =>
  v != null && typeof (v as { then?: unknown }).then === "function";

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

let scopeCounter = 0;

/** Evaluate `source` in the shared session under a fresh scope; the value is the
 *  interpreter's membrane JS face (`schemeToJs`, the same exit `runProgram` takes). */
export async function evalInterpreter(session: OracleSession, source: string): Promise<Outcome> {
  try {
    const scope = LexicalScope.fresh(`oracle-${scopeCounter++}`);
    await execState(BUILTIN_PREAMBLE, { ambient: session.ambient, scope });
    const forms = await parseGenerator(source);
    let last: unknown;
    for (const form of forms) {
      const state = await execState(form, { ambient: session.ambient, scope });
      last = state.values.at(-1);
      if (isThenable(last)) last = await last; // the evaluator can hand back an unforced Promise
    }
    return { kind: "value", value: schemeToJsUntyped(last, {}) };
  } catch (e) {
    return { kind: "throw", errorClass: classifyInterpreterError(e), message: messageOf(e), raw: e };
  }
}

/**
 * R7RS `(error …)` support for the artifact world: mercury lowers `(error …)`
 * to a bare `error(…)` call with no runtime behind it yet, so the harness
 * supplies the deterministic throwing shim (the "user-error" ErrorClass's
 * compiled half — the immutability-legal short-circuit probe, spec §2/§4.3).
 * Function declaration ⇒ hoisted, callable from any emitted position; a corpus
 * program that (pathologically) defines its own `error` collides loudly with a
 * SyntaxError instead of silently shadowing the probe.
 */
const COMPILED_PREAMBLE = `// ── oracle harness preamble (arrival-mercury, generated — never committed) ──
class __OracleUserError extends Error {
  readonly irritants: readonly unknown[];
  constructor(message: unknown, irritants: readonly unknown[]) {
    super(String(message));
    this.name = "OracleUserError";
    this.irritants = irritants;
  }
}
function error(message: unknown, ...irritants: unknown[]): never {
  throw new __OracleUserError(message, irritants);
}
`;

/**
 * Rewrite the compiled module's LAST top-level chunk (raw `assemble` output
 * joins forms with `\n\n`; a single lowered form never contains a blank line)
 * into `export const __oracleResult = <expr>;` — the exporting twin of
 * `compile-project.ts::printEntryResult`. Throws a plain harness error (never
 * an Outcome) when the program has no trailing EXPRESSION to observe: that is
 * corpus-authoring misuse, not a semantics divergence.
 */
function exportTrailingResult(compiled: string): string {
  const cut = compiled.lastIndexOf("\n\n");
  const head = cut === -1 ? "" : compiled.slice(0, cut);
  const tail = (cut === -1 ? compiled : compiled.slice(cut + 2)).trim();
  if (tail === "") {
    throw new Error("oracle evalCompiled: empty compiled output — no trailing expression to observe");
  }
  if (/^(const|let|var|function|class|import|export|type|interface|enum|declare)\b/.test(tail)) {
    throw new Error(
      `oracle evalCompiled: the program's last top-level form must be an expression (the value under test), got a statement: ${tail.slice(0, 80)}`,
    );
  }
  const expr = tail.replace(/;$/, "");
  return `${head === "" ? "" : `${head}\n\n`}export const __oracleResult = ${expr};\n`;
}

const SCRATCH_ROOT = fileURLToPath(new URL("../../.oracle-tmp/", import.meta.url));
/**
 * Scratch subdir unique PER MODULE INSTANCE, not per process: vitest reuses a
 * forked worker across test files with a fresh module registry each time, so a
 * pid+counter filename repeats within one process while tsx's loader cache is
 * per-PROCESS — a repeated path would serve test-file A's cached module as
 * test-file B's result (observed as a corpus-vs-smoke value flake). The random
 * component makes every URL this instance ever imports globally fresh.
 */
const SCRATCH_DIR = path.join(SCRATCH_ROOT, `run-${process.pid}-${randomBytes(6).toString("hex")}`);
let scratchCounter = 0;

/** Best-effort scratch cleanup — not load-bearing (the directory is gitignored
 *  and outside tsconfig's `src/**` include), but a clean run leaves no litter.
 *  Removes only THIS instance's subdir: sibling vitest workers may still be
 *  mid write→import in their own subdirs (a whole-root rm mid-run is the
 *  ENOENT flake this layout exists to prevent). The root rmdir is non-recursive
 *  on purpose — it only succeeds for whoever cleans last. */
export function cleanupOracleScratch(): void {
  rmSync(SCRATCH_DIR, { recursive: true, force: true });
  try {
    rmdirSync(SCRATCH_ROOT);
  } catch {
    /* not empty or absent — another worker's litter is not ours to sweep */
  }
}

/**
 * Compile `source` (run-view, `strategy` defaulting to `DEFAULT_STRATEGY`) and
 * execute the artifact in-process. Mercury's own compile-time doors surface as
 * classified throw-Outcomes — the same path "unsupported-form" uses (spec §2).
 */
export async function evalCompiled(source: string, opts?: { strategy?: Strategy }): Promise<Outcome> {
  let compiled: string;
  try {
    compiled = projectToJsRaw(source, { target: "run", strategy: opts?.strategy ?? DEFAULT_STRATEGY });
  } catch (e) {
    return { kind: "throw", errorClass: classifyCompiledError(e), message: messageOf(e), raw: e };
  }
  const module = `${COMPILED_PREAMBLE}\n${exportTrailingResult(compiled)}`;
  mkdirSync(SCRATCH_DIR, { recursive: true });
  const file = path.join(SCRATCH_DIR, `case-${process.pid}-${scratchCounter++}.mts`);
  writeFileSync(file, module, "utf8");
  try {
    const ns = (await tsImport(pathToFileURL(file).href, import.meta.url)) as { __oracleResult?: unknown };
    let value: unknown = ns.__oracleResult;
    if (isThenable(value)) value = await value; // symmetric with the interpreter side
    return { kind: "value", value };
  } catch (e) {
    return { kind: "throw", errorClass: classifyCompiledError(e), message: messageOf(e), raw: e };
  }
}

const bigintEqualsNumber = (big: bigint, num: unknown): boolean =>
  typeof num === "number" && Number.isInteger(num) && BigInt(num) === big;

function isPlainObjectLike(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function sameKeysDeep(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.hasOwn(b, k) && oracleEqual(a[k], b[k]));
}

/**
 * Object.is-based equality, recursive over arrays/dicts, proxy-transparent
 * (`Array.isArray` unwraps a Proxy to its target per spec, so egress-proxy
 * results compare structurally). `Object.is` as the scalar default — not `===`
 * — is what makes the `-0`/`NaN` eqv?-sentinel rows and the general numeric
 * path share one function (spec §4.2). The bigint branch is host-only: scheme
 * numeric values never egress as bigint post one-number-rework; it exists
 * solely for an opaque HOST bigint pass-through reaching the comparator.
 */
export function oracleEqual(a: unknown, b: unknown): boolean {
  if (typeof a === "bigint" && typeof b === "bigint") return a === b;
  if (typeof a === "bigint") return bigintEqualsNumber(a, b);
  if (typeof b === "bigint") return bigintEqualsNumber(b, a);
  if (typeof a === "number" && typeof b === "number") return Object.is(a, b); // NaN≡NaN, +0≢−0
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => oracleEqual(x, b[i]));
  if (isPlainObjectLike(a) && isPlainObjectLike(b)) return sameKeysDeep(a, b);
  return Object.is(a, b);
}

/** Render a value for a verdict/failure message — never throws (bigint-safe). */
export function show(v: unknown): string {
  try {
    return JSON.stringify(v, (_k, x: unknown) => (typeof x === "bigint" ? `${x}n` : x)) ?? String(v);
  } catch {
    return String(v);
  }
}

export interface OracleVerdict {
  agree: boolean;
  interpreter: Outcome;
  compiled: Outcome;
  detail?: string;
}

/**
 * The agreement law over a pair of outcomes: value≡value via `oracleEqual`,
 * throw≡throw via ErrorClass — never the message (spec §4.2). A both-throw
 * pair that classifies `"other"` is a TAXONOMY GAP and fails loudly rather
 * than counting as agreement — Law F's "never wrong, always visible" stance
 * applied to the oracle's own honesty.
 */
export function agreementOf(interpreter: Outcome, compiled: Outcome): { agree: boolean; detail?: string } {
  if (interpreter.kind === "value" && compiled.kind === "value") {
    return oracleEqual(interpreter.value, compiled.value)
      ? { agree: true }
      : {
          agree: false,
          detail: `value mismatch: interpreter=${show(interpreter.value)} compiled=${show(compiled.value)}`,
        };
  }
  if (interpreter.kind === "throw" && compiled.kind === "throw") {
    if (interpreter.errorClass !== compiled.errorClass) {
      return {
        agree: false,
        detail: `error-class mismatch: interpreter=${interpreter.errorClass} ("${interpreter.message}") compiled=${compiled.errorClass} ("${compiled.message}")`,
      };
    }
    if (interpreter.errorClass === "other") {
      return {
        agree: false,
        detail: `taxonomy gap: both sides threw but classify "other" (interpreter: "${interpreter.message}"; compiled: "${compiled.message}") — extend error-classifier.ts; "other" never counts as agreement`,
      };
    }
    return { agree: true };
  }
  return { agree: false, detail: `outcome-kind mismatch: interpreter=${interpreter.kind} compiled=${compiled.kind}` };
}

/** One differential run: interpreter vs compiled, agreement per `agreementOf`. */
export async function runOracle(
  session: OracleSession,
  source: string,
  opts?: { strategy?: Strategy },
): Promise<OracleVerdict> {
  const interpreter = await evalInterpreter(session, source);
  const compiled = await evalCompiled(source, opts);
  return { ...agreementOf(interpreter, compiled), interpreter, compiled };
}
