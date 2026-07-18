/**
 * COPY-AS-CHUNK (constitution §4.5 — greenfield package, never shared imports).
 * Sources: arrival/packages/mercury/src/stdlib.ts (the name ROSTER only) +
 * foundations/arrival/arrival-sugarcoat/src/sugarcoat-render.ts (`decodeAccessor`,
 * reduced to its acceptance test).
 *
 * Adaptations from the source chunks:
 *   - REDUCED to head classification. The type pass asks exactly one question —
 *     "does this head lower to an ambient `__arr` member call?" — so only the KEY
 *     SETS survive; the string `Emitter` bodies are run-plane machinery the
 *     Residual algebra replaces (constitution §3.4) and must not seed the
 *     greenfield tree. The three lists mirror the source's STDLIB / BINOP / UNOP
 *     tables 1:1 (BINOP/UNOP overlap STDLIB — kept verbatim for diffability).
 *   - `decodeAccessor`'s PULL/DROP chain is dropped: the type pass emits the
 *     accessor WORD itself as an `__arr` member (`(cadr p)` → `__arr.cadr(p)`)
 *     and never decomposes it, so only the `c[ad]+r` acceptance regex is kept.
 *   - Transitional module: the registry harvest (`../registry`) becomes the name
 *     authority when the engine walker integrates (registry-emit.md) — this
 *     roster then dissolves into harvested rows.
 */

// stdlib.ts STDLIB table keys.
const STDLIB_NAMES = [
  "map",
  "filter",
  "every",
  "some",
  "list",
  "cons",
  "list-ref",
  "first",
  "length",
  "reverse",
  "append",
  "min",
  "max",
  "apply",
  "max-by",
  "+",
  "-",
  "*",
  "/",
  "modulo",
  "remainder",
  "quotient",
  "=",
  "<",
  ">",
  "<=",
  ">=",
  "eq?",
  "eqv?",
  "equal?",
  "string=?",
  "string-ci=?",
  "string-append",
  "zero?",
  "even?",
  "odd?",
  "null?",
  "empty?",
  "not",
  "and",
  "or",
  "dict",
] as const;

// stdlib.ts BINOP table keys (operator-as-argument forms).
const BINOP_NAMES = [
  "+",
  "-",
  "*",
  "/",
  "=",
  "<",
  ">",
  "<=",
  ">=",
  "cons",
  "eq?",
  "eqv?",
  "equal?",
  "string=?",
  "string-ci=?",
  "modulo",
  "remainder",
  "quotient",
] as const;

// stdlib.ts UNOP table keys.
const UNOP_NAMES = ["first", "zero?", "even?", "odd?", "not", "null?", "empty?", "length"] as const;

const BUILTIN_NAMES: ReadonlySet<string> = new Set([...STDLIB_NAMES, ...BINOP_NAMES, ...UNOP_NAMES]);

/** A `c[ad]+r` pair-accessor word (car, cdr, cadr, caadr, cadadr, … at any depth) —
 *  `decodeAccessor`'s acceptance test, without the PULL/DROP decomposition. */
const isAccessor = (name: string): boolean => /^c[ad]+r$/.test(name);

/** Is `name` a stdlib builtin (so it is emitted as an ambient `__arr` member call,
 *  never a free identifier)? Mirrors stdlib.ts's `isBuiltin` exactly. */
export const isBuiltin = (name: string): boolean => BUILTIN_NAMES.has(name) || isAccessor(name);
