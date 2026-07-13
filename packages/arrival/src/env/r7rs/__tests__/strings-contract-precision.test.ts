// strings-contract-precision.test.ts — RUNTIME proof for the `scheme/strings` capability's
// 2026-07-05 fresh full-file audit: 8 categories of degraded/loose Contract declarations
// tightened to the actual scheme-value domain each op's impl reads. Mirrors the sibling
// audits' established pattern exactly (numeric-contract-precision.test.ts /
// chars-contract-precision.test.ts / contract-precision-fixes.test.ts): a schema's
// PRECISION is only observable at runtime (zod's own `safeParse`) — native ops never run
// this validation during evaluation (bakeNative binds `impl` raw, no decode/encode; see
// _bake.ts), so this is a HARVEST/type-surface proof, not a behavior change. The
// behavior-unchanged proof is the pre-existing r7rs-identity/r7rs-unicode/chibi-r7rs suites
// run byte-identical before/after (see the report).
//
// The 8 fixes (all on `scheme/strings`, src/env/r7rs/strings.ts):
//   1. `string`            — builds a string from chars: z.array(z.unknown()) → z.array(z.schemeChar)
//   2. 10 comparison ops   — string=?/</>/<=/>=  + string-ci variants: z.array(z.unknown()) → z.array(z.schemeString)
//   3. `string-append`     — homogeneous variadic strings: z.array(z.unknown()) → z.array(z.schemeString)
//   4. `string->list`      — output is a proper list of chars: [z.unknown()] → [z.union([z.pair, z.nil])]
//   5. `list->string`      — input walks a Pair (a list of chars): [z.unknown()] → [z.union([z.pair, z.nil])]
//   6. `join`               — 2nd arg is a list: z.value → z.union([z.pair, z.nil])
//   7. `concat`             — args are strings: z.array(z.value) → z.array(z.schemeString)
//
// (item #8, `split`'s output-side fix, was a stale/misfiled reference in the original audit —
// no `split` symbol is bound in this pack; LIPS's `string-split` lives in `scheme/srfi-13`.)
//
// #4 is an OUTPUT-side fix — unlike the other 5 (pure input-side, contravariant-safe,
// zero impl signature changes needed), narrowing an OUTPUT schema is a COVARIANT position:
// the impl's own declared return type must narrow to match (a function declared to return
// `unknown` cannot satisfy a Contract whose decoded return is `APair | ANil`) — so it
// also touches strings.ts's impl return-type annotations (still behavior-preserving: bodies
// are byte-for-byte unchanged, only the compile-time annotation tightens). See the report.
//
// Blanket sweep note: a single fixed-size "garbage" probe only exercises ELEMENT precision
// for the genuinely-unbounded array-ish ops (string / comparisons / string-append / concat —
// #1-3, #7); the fixed-arity tuple ops (#4-6) reject an over-length garbage array on
// ARITY alone regardless of element precision, so their fixes are proven by dedicated
// single-element probes instead (a same-arity, wrong-shaped value).

import { describe, expect, it } from "vitest";
import stringsPack from "../strings.js";
import { STRING_FOR_EACH_HOF, STRING_MAP_HOF } from "../../../common/hof-sig.js";
import { signatureOf } from "../../../type-layer/schema-to-ts.js";
import type { AEntity } from "../../../common/symbol.js";
import { AString } from "../../../values/primitives/AString.js";
import { ACharacter } from "../../../values/primitives/ACharacter.js";
import { APair } from "../../../values/primitives/APair.js";
import { nil } from "../../../values/primitives/ANil.js";
import { CONSTANT_CTX } from "../../../values/primitives/RunContext.js";

const symbols = stringsPack.spec.symbols as Record<string, AEntity>;

function nativeDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`strings pack: no symbol named ${name}`);
  if (def.kind !== "native") throw new Error(`strings pack: ${name} is not a native def (got ${def.kind})`);
  return def;
}

// `concat` migrated to `symbol.rosetta` since this audit's own header was written (still
// carries `.in`/`.out`, same as native — only the bind KIND differs), so it needs its own
// accessor rather than `nativeDef`'s native-only guard.
function rosettaDef(name: string) {
  const def = symbols[name];
  if (def === undefined) throw new Error(`strings pack: no symbol named ${name}`);
  if (def.kind !== "rosetta") throw new Error(`strings pack: ${name} is not a rosetta def (got ${def.kind})`);
  return def;
}

const ch = (c: string): ACharacter => new ACharacter(CONSTANT_CTX, c);
const str = (s: string): AString => new AString(CONSTANT_CTX, s);
const properList = (): APair<any, any> => new APair(CONSTANT_CTX, ch("a"), nil);

const COMPARISON_OPS = [
  "string=?",
  "string<?",
  "string>?",
  "string<=?",
  "string>=?",
  "string-ci=?",
  "string-ci<?",
  "string-ci>?",
  "string-ci<=?",
  "string-ci>=?",
] as const;

describe("scheme/strings Contract precision — 2026-07-05 audit: 8 fixes on the REAL exported ops", () => {
  // INVARIANT: string accepts real ACharacter elements, rejecting raw JS strings
  it("string: accepts real characters, rejects raw JS strings as elements (was z.array(z.unknown()))", () => {
    const def = nativeDef("string");
    expect(def.in.safeParse([ch("a"), ch("b")]).success).toBe(true);
    expect(def.in.safeParse(["a", "b"]).success).toBe(false);
  });

  // INVARIANT: every one of the 10 string comparison ops accepts real-AString arrays of any
  // arity and rejects a same-length raw-string array
  it("every comparison op: real strings of any arity parse, a same-length raw-string array no longer does", () => {
    for (const name of COMPARISON_OPS) {
      const def = nativeDef(name);
      expect(def.in.safeParse([]).success, `${name}: empty array (0-arity trivial true)`).toBe(true);
      expect(def.in.safeParse([str("x")]).success, `${name}: single real string`).toBe(true);
      expect(def.in.safeParse([str("x"), str("y")]).success, `${name}: real string array`).toBe(true);
      expect(def.in.safeParse(["x", "y"]).success, `${name}: raw string array — was true, now false`).toBe(false);
    }
  });

  // INVARIANT: string-append accepts real AString elements, rejecting raw JS strings
  it("string-append: accepts real strings, rejects raw JS strings as elements (was z.array(z.unknown()))", () => {
    const def = nativeDef("string-append");
    expect(def.in.safeParse([str("a"), str("b")]).success).toBe(true);
    expect(def.in.safeParse(["a", "b"]).success).toBe(false);
  });

  // INVARIANT: string->list's output must be a proper list, rejecting a raw string
  it("string->list: output must be a proper list (Pair|Nil) — a raw string no longer satisfies it (was [z.unknown()])", () => {
    const def = nativeDef("string->list");
    expect(def.out.safeParse([properList()]).success).toBe(true);
    expect(def.out.safeParse([nil]).success).toBe(true);
    expect(def.out.safeParse(["not-a-list"]).success).toBe(false);
  });

  // INVARIANT: list->string's input must be a proper list, rejecting a raw string
  it("list->string: input must be a proper list (Pair|Nil) — a raw string no longer satisfies it (was [z.unknown()])", () => {
    const def = nativeDef("list->string");
    expect(def.in.safeParse([properList()]).success).toBe(true);
    expect(def.in.safeParse([nil]).success).toBe(true);
    expect(def.in.safeParse(["not-a-list"]).success).toBe(false);
  });

  // INVARIANT: join's second argument must be a proper list, rejecting a raw string
  it("join: 2nd arg must be a proper list (Pair|Nil) — a raw string no longer satisfies it (was z.value)", () => {
    const def = nativeDef("join");
    expect(def.in.safeParse([str(", "), properList()]).success).toBe(true);
    expect(def.in.safeParse([str(", "), nil]).success).toBe(true);
    expect(def.in.safeParse([str(", "), "not-a-list"]).success).toBe(false);
  });

  // INVARIANT: concat (migrated to symbol.rosetta) accepts real AString elements,
  // rejecting raw JS strings
  it("concat: accepts real strings, rejects raw JS strings as elements (was z.array(z.value)) — since migrated to symbol.rosetta", () => {
    const def = rosettaDef("concat");
    expect(def.in.safeParse([str("a"), str("b")]).success).toBe(true);
    expect(def.in.safeParse(["a", "b"]).success).toBe(false);
  });

  // NOTE: no symbol named `split` is bound in this pack (verified: `grep -rn '"split"'
  // src/env/`). LIPS's `string-split` lives in `scheme/srfi-13` (env/srfi/srfi-13.ts), a
  // DIFFERENT capability — this item was a stale/misfiled reference in the original audit
  // header (item #8), not a fix that ever landed here. Dropped rather than faked.

  // INVARIANT: no native op in the strings pack accepts an arbitrary-shape raw-JS-garbage
  // array — no stragglers
  it("blanket sweep: no native op in the pack accepts an arbitrary-shape raw-JS-garbage array on .in (mirrors numeric-/chars-contract-precision.test.ts)", () => {
    const garbage = ["not-a-value", 123, null, {}];
    const stragglers: string[] = [];
    for (const [name, def] of Object.entries(symbols)) {
      if (def.kind !== "native") continue;
      if (def.in.safeParse(garbage).success) stragglers.push(name);
    }
    expect(stragglers).toEqual([]);
  });

  // INVARIANT: the strings pack exports exactly 32 symbols (deliberate drift alarm —
  // forces a reviewer to touch this test when a symbol is added/removed)
  it("sanity: the pack exports exactly 32 symbols — the scope this fix must cover", () => {
    expect(Object.keys(symbols)).toHaveLength(32);
  });

  // INVARIANT: string-map/string-for-each's earlier inputRest fix remains intact —
  // regression pin
  it("regression pin: string-map/string-for-each's earlier inputRest fix is untouched by this round", () => {
    const mapDef = nativeDef("string-map");
    expect(mapDef.in.safeParse([(): void => {}, str("abc")]).success).toBe(true);
    expect(mapDef.in.safeParse([(): void => {}, "raw-js-string"]).success).toBe(false);
  });
});

describe("scheme/strings Contract.type overrides — the harvest signature for the two HOFs whose z.custom callable HEAD is UNREPRESENTABLE (printer throws, degrading the whole signature to `(...args: unknown[]) => unknown` and losing the string rest + the string/void return)", () => {
  // string-map/string-for-each declare `input: [z.custom<callable>()], inputRest: z.schemeString`.
  // The callable head is unrepresentable to the harvest printer, so the WHOLE signature degrades
  // to the catch-all — throwing away the fn-first shape, the `string[]` rest (harvested straight
  // from z.schemeString), and the string / void return. `Contract.type` restores the real shape
  // (same convention as the sibling srfi curry/find overrides: callable → `(...args: unknown[]) =>
  // unknown`, a void HOF return → bare `void` as in env/core/core.ts's own hand-written type).
  // INVARIANT: string-map's harvested signature is proc-first over a string rest,
  // returning string (pins implementation, not behavior)
  it("string-map: proc-first over a string rest → string", () => {
    expect(signatureOf(nativeDef("string-map"))).toBe(STRING_MAP_HOF);
  });
  // INVARIANT: string-for-each's harvested signature is proc-first over a string rest,
  // returning void (pins implementation, not behavior)
  it("string-for-each: proc-first over a string rest, for effect → void", () => {
    expect(signatureOf(nativeDef("string-for-each"))).toBe(STRING_FOR_EACH_HOF);
  });
});
