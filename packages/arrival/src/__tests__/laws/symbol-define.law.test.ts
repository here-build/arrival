/**
 * LAW — `symbol.define` / `symbol.defineSyntax` (docs/working-proposals/symbol-define-
 * static-program-validation.md §1/§2, wave W1). Pins the kind shapes, the bake
 * mechanics (parse/FV/derived-role), the two-phase binding order, and defineSyntax's
 * macro binds+expands — the exact law rows the wave's own spec names:
 *
 *   1. bake round-trip (declare → assemble → call)
 *   2. contract enforcement fires (wrong-arity/wrong-type teaching error)
 *   3. the FV locality drift door fires (§2.1)
 *   4. the derived-role drift door fires (§1.4)
 *   5. two-phase order is pinned (a define referencing a same-capability native/rosetta sibling)
 *   6. sequential-RHS semantics are pinned (an eager forward reference is a bake door, §2.3)
 *   7. defineSyntax macro binds + expands (§1.5)
 *
 * No pack migrates in this wave — every capability here is test-local.
 */
import { describe, expect, it } from "vitest";
import { symbol } from "../../common/symbol.js";
import { EnvCapability } from "../../common/capability.js";
import * as z from "../../common/scheme-zod.js";
import { exec, execState } from "../../eval/generator-exec.js";
import { freshEnv } from "../_fresh-env.js";
import { DefineForwardReferenceError, DefineLocalityError, ProvenanceRoleShapeError } from "../../errors.js";
import type { ResolvingEnvironment } from "../../Environment.js";

// The injected evalScheme every direct `.apply()` call in this suite needs — mirrors
// `_fresh-env.ts`'s own (skipBootstrapWait: these execs run AFTER the shared bootstrap
// that produced `env`, so re-awaiting it would be a redundant, already-settled promise,
// not a deadlock — unlike the base-pack assembly's OWN prelude evalScheme).
const evalScheme = (env: unknown, src: unknown): unknown =>
  exec(src as string, { env: env as ResolvingEnvironment, skipBootstrapWait: true });

describe("symbol.define — bake round-trip, two-phase order, sequential-RHS, contract enforcement", () => {
  it("declares → assembles → calls: a define referencing a SAME-CAPABILITY rosetta sibling", async () => {
    const env = await freshEnv();

    // Phase 1 (rosetta) must bind before Phase 2 (define) evaluates — the sibling
    // reference below only resolves if two-phase order actually holds.
    const bump = symbol.rosetta`bump: adds one`({ input: [z.number], output: [z.number] }, (n: number) => n + 1);
    const useBump = symbol.define`use-bump: calls the same-capability rosetta sibling`(
      { input: [z.number], output: [z.number] },
      `(lambda (n) (bump n))`,
    );
    const cap = new EnvCapability("test/define-round-trip", { symbols: { bump, "use-bump": useBump } });
    await cap.lower({ evalScheme }).apply(env, undefined as never);

    const [result] = await exec(`(use-bump 41)`, { env });
    expect(result).toBe(42);
  });

  it("sequential-RHS: declaration order = evaluation order (a later define sees an EARLIER eager constant)", async () => {
    const env = await freshEnv();
    const base = symbol.define`base-value: an eager constant`(z.number, `10`);
    const derived = symbol.define`derived-value: an eager constant referencing the EARLIER base-value`(
      z.number,
      `base-value`,
    );
    const cap = new EnvCapability("test/define-sequential-rhs", { symbols: { "base-value": base, "derived-value": derived } });
    await cap.lower({ evalScheme }).apply(env, undefined as never);

    const [result] = await exec(`derived-value`, { env });
    expect(result).toBe(10);
  });

  it("contract ENFORCEMENT fires: a scheme-face type mismatch throws at the call boundary", async () => {
    const env = await freshEnv();
    // The body doesn't matter for THIS law — validation runs BEFORE the underlying
    // lambda ever executes — so a trivial identity keeps the fixture self-contained
    // (no external `+` dep needed).
    const strictAdd = symbol.define`strict-add1: contract-enforced identity`(
      { input: [z.number], output: [z.number] },
      `(lambda (n) n)`,
    );
    const cap = new EnvCapability("test/define-contract-enforcement", { symbols: { "strict-add1": strictAdd } });
    await cap.lower({ evalScheme }).apply(env, undefined as never);

    // A STRING where a number is contracted — the scheme-face z.decode must reject it
    // before the underlying lambda ever runs.
    await expect(execState(`(strict-add1 "not-a-number")`, { env })).rejects.toThrow();
  });

  it("`validate: false` skips the contract check (the cost valve, §1.2)", async () => {
    const env = await freshEnv();
    const unchecked = symbol.define`unchecked-echo: no contract enforcement`(
      { input: [z.number], output: [z.number] },
      `(lambda (n) n)`,
      { validate: false },
    );
    const cap = new EnvCapability("test/define-validate-false", { symbols: { "unchecked-echo": unchecked } });
    await cap.lower({ evalScheme }).apply(env, undefined as never);
    // Passing a STRING (not a number) does NOT throw at the contract boundary —
    // it flows straight through to the lambda, which just returns it unchanged.
    const [result] = await exec(`(unchecked-echo "hello")`, { env });
    expect(result).toBe("hello");
  });

  it("a CONSTANT define (bare ZodType contract) validates ONCE at bake and binds a plain value", async () => {
    const env = await freshEnv();
    const answer = symbol.define`the-answer: a constant`(z.number, `42`);
    const cap = new EnvCapability("test/define-constant", { symbols: { "the-answer": answer } });
    await cap.lower({ evalScheme }).apply(env, undefined as never);
    const [result] = await exec(`the-answer`, { env });
    expect(result).toBe(42);
  });
});

describe("symbol.define — the §2.1 bake FV locality law (the drift door)", () => {
  it("a body referencing an undeclared free name throws DefineLocalityError at bake", async () => {
    const env = await freshEnv();
    const bad = symbol.define`bad-ref: references an undeclared free name`(z.number, `undeclared-free-name`);
    const cap = new EnvCapability("test/define-fv-drift", { symbols: { "bad-ref": bad } });
    await expect(cap.lower({ evalScheme }).apply(env, undefined as never)).rejects.toThrow(DefineLocalityError);
  });

  it("a body referencing a SAME-CAPABILITY sibling (any kind) passes the FV law", async () => {
    const env = await freshEnv();
    const helper = symbol.rosetta`fv-helper: identity`({ input: [z.number], output: [z.number] }, (n: number) => n);
    const uses = symbol.define`fv-uses: calls its own capability's sibling`(
      { input: [z.number], output: [z.number] },
      `(lambda (n) (fv-helper n))`,
    );
    const cap = new EnvCapability("test/define-fv-ok", { symbols: { "fv-helper": helper, "fv-uses": uses } });
    await expect(cap.lower({ evalScheme }).apply(env, undefined as never)).resolves.not.toThrow();
  });

  it("SPECIAL_FORMS/KEYWORD_SYNTAX (if/lambda/let/…) are an unconditional baseline — never a drift-door false positive", async () => {
    const env = await freshEnv();
    // Only `if`/`let`/`lambda` (special forms) + the param + literals — no external
    // ops (`>`/`*`/…) at all, so this ISOLATES the keyword baseline specifically.
    const controlFlow = symbol.define`control-flow: uses if/let, no deps declared`(
      { input: [z.number], output: [z.number] },
      `(lambda (n) (if #t (let ((doubled n)) doubled) 0))`,
    );
    const cap = new EnvCapability("test/define-keyword-baseline", { symbols: { "control-flow": controlFlow } });
    await expect(cap.lower({ evalScheme }).apply(env, undefined as never)).resolves.not.toThrow();
  });

  // PRE-H2 machinery fix wave — gap (1): `car`/`cdr` (the whole `c[ad]+r` family) are
  // NOT a capability-declared export anywhere (`env/r7rs/lists.ts`'s header: "served
  // by a resolver, not this pack") — synthesized by a KERNEL-level fallback
  // (`eval/Resolver.ts`'s `cxrUnfold`), never registered as a per-capability
  // `ResolverSpec`, so `resolverAnswers`'s pure-resolver probe can never see it. The
  // fix recognizes the same `CXR_RE` pattern directly in the bake allowlist (a local
  // copy of the regex `static-validation/vocabulary.ts` and `eval/Resolver.ts`
  // already carry). Before the fix, EVERY row below threw `DefineLocalityError`
  // unconditionally.
  it("a body referencing bare car/cdr (the resolver-synth cxr family) bakes clean — no ResolverSpec, no deps declared", async () => {
    const env = await freshEnv();
    const firstOfPair = symbol.define`first-of-pair: bare car, no deps`(
      { input: [z.value], output: [z.value] },
      `(lambda (p) (car p))`,
    );
    const cap = new EnvCapability("test/define-cxr-car", { symbols: { "first-of-pair": firstOfPair } });
    await expect(cap.lower({ evalScheme }).apply(env, undefined as never)).resolves.not.toThrow();
  });

  it("a body referencing a longer cxr-family name (bare cadr) also bakes clean", async () => {
    const env = await freshEnv();
    const secondOfPair = symbol.define`second-of-pair: bare cadr, no deps`(
      { input: [z.value], output: [z.value] },
      `(lambda (p) (cadr p))`,
    );
    const cap = new EnvCapability("test/define-cxr-cadr", { symbols: { "second-of-pair": secondOfPair } });
    await expect(cap.lower({ evalScheme }).apply(env, undefined as never)).resolves.not.toThrow();
  });

  it("a name that merely LOOKS cxr-shaped but isn't a real c[ad]+r spelling still drift-doors", async () => {
    const env = await freshEnv();
    // "cars" fails CXR_RE (trailing non-a/d before the final r) — must NOT be
    // over-forgiven by the new allowlist branch.
    const bad = symbol.define`bad-cxr-lookalike: "cars" is not a real cxr name`(z.value, `cars`);
    const cap = new EnvCapability("test/define-cxr-lookalike", { symbols: { "bad-cxr-lookalike": bad } });
    await expect(cap.lower({ evalScheme }).apply(env, undefined as never)).rejects.toThrow(DefineLocalityError);
  });
});

describe("symbol.define — §2.3's eager-forward-reference door", () => {
  it("an EAGER (non-lambda) RHS referencing a LATER-declared sibling throws DefineForwardReferenceError", async () => {
    const env = await freshEnv();
    const early = symbol.define`early-eager: eagerly references a LATER sibling`(z.number, `later-sibling`);
    const later = symbol.define`later-sibling: an eager constant`(z.number, `5`);
    const cap = new EnvCapability("test/define-forward-ref", { symbols: { "early-eager": early, "later-sibling": later } });
    await expect(cap.lower({ evalScheme }).apply(env, undefined as never)).rejects.toThrow(DefineForwardReferenceError);
  });

  it("a LAMBDA body referencing a LATER sibling is legal — it late-binds at CALL time, not bake", async () => {
    const env = await freshEnv();
    const early = symbol.define`late-binder: a lambda referencing a LATER sibling`(
      { input: [], output: [z.number] },
      `(lambda () (later-value))`,
    );
    const later = symbol.define`later-value: a 0-ary procedure declared AFTER late-binder`(
      { input: [], output: [z.number] },
      `(lambda () 7)`,
    );
    const cap = new EnvCapability("test/define-late-bind", { symbols: { "late-binder": early, "later-value": later } });
    await cap.lower({ evalScheme }).apply(env, undefined as never);
    const [result] = await exec(`(late-binder)`, { env });
    expect(result).toBe(7);
  });
});

describe("symbol.define — §1.4 derived provenance role + its drift door", () => {
  it("a fixpoint-closed (port-free) body derives \"pipe\"", async () => {
    const env = await freshEnv();
    const pure = symbol.define`pure-thing: a pure lambda, no ports`({ input: [z.number], output: [z.number] }, `(lambda (n) n)`);
    const cap = new EnvCapability("test/define-derived-pipe", { symbols: { "pure-thing": pure } });
    await cap.lower({ evalScheme }).apply(env, undefined as never);
    const proc = env.get("pure-thing") as { provenanceRole?: string };
    expect(proc.provenanceRole).toBe("pipe");
  });

  it("a body reaching a port (calling a same-capability SOURCE rosetta) derives \"opaque\"", async () => {
    const env = await freshEnv();
    // rosetta defaults to "source" (mints) — the port this define's body reaches.
    const mint = symbol.rosetta`mint-source: a source rosetta`({ input: [], output: [z.number] }, () => 99);
    const wraps = symbol.define`wraps-source: reaches a port through mint-source`(
      { input: [], output: [z.number] },
      `(lambda () (mint-source))`,
    );
    const cap = new EnvCapability("test/define-derived-opaque", { symbols: { "mint-source": mint, "wraps-source": wraps } });
    await cap.lower({ evalScheme }).apply(env, undefined as never);
    const proc = env.get("wraps-source") as { provenanceRole?: string };
    expect(proc.provenanceRole).toBe("opaque");
  });

  it("a DECLARED role that contradicts the DERIVED classification throws ProvenanceRoleShapeError", async () => {
    const env = await freshEnv();
    const mint = symbol.rosetta`mint-source-2: a source rosetta`({ input: [], output: [z.number] }, () => 1);
    const liar = symbol.define`liar-pipe: declares "pipe" but its body reaches a port`(
      { input: [], output: [z.number], provenance: "pipe" },
      `(lambda () (mint-source-2))`,
    );
    const cap = new EnvCapability("test/define-role-drift", { symbols: { "mint-source-2": mint, "liar-pipe": liar } });
    await expect(cap.lower({ evalScheme }).apply(env, undefined as never)).rejects.toThrow(ProvenanceRoleShapeError);
  });

  it("a declared role MATCHING the derived classification is a legal no-op (no drift door)", async () => {
    const env = await freshEnv();
    const honest = symbol.define`honest-pipe: declares "pipe" and IS pipe`(
      { input: [z.number], output: [z.number], provenance: "pipe" },
      `(lambda (n) n)`,
    );
    const cap = new EnvCapability("test/define-role-honest", { symbols: { "honest-pipe": honest } });
    await expect(cap.lower({ evalScheme }).apply(env, undefined as never)).resolves.not.toThrow();
  });
});

describe("symbol.defineSyntax — macro binds + expands (§1.5)", () => {
  it("a fexpr-shaped defineSyntax binds a working macro that expands at the call site", async () => {
    const env = await freshEnv();
    // `my-twice`: (my-twice EXPR) → (begin EXPR EXPR) — the UNEVALUATED expr form is
    // bound to the closure's own `expr` param, fexpr-style. Observing "expanded to
    // TWO calls" needs a side effect arrival's pure-dataflow invariant omits at the
    // SCHEME level (`set!` is doored) — a rosetta counter mutates in JS-land instead,
    // invisible to (and unrestricted by) that invariant.
    let calls = 0;
    const bump = symbol.rosetta`bump!: JS-side call counter`({ input: [], output: [z.number] }, () => ++calls);
    const myTwice = symbol.defineSyntax`my-twice: expands to (begin expr expr)`(
      "(lambda (expr) `(begin ,expr ,expr))",
    );
    const cap = new EnvCapability("test/define-syntax-basic", { symbols: { "bump!": bump, "my-twice": myTwice } });
    await cap.lower({ evalScheme }).apply(env, undefined as never);

    const [result] = await exec(`(my-twice (bump!))`, { env });
    expect(calls).toBe(2); // the macro expanded to TWO calls, not one
    expect(result).toBe(2); // (begin 1 2) → the LAST call's value
  });

  it("the DEFAULT macroAttribute is \"opaque\"; an explicit one round-trips on the baked def", () => {
    const def = symbol.defineSyntax`plain: default attribute`("(lambda (x) x)");
    expect(def.macroAttribute).toBe("opaque");
    const binder = symbol.defineSyntax`receive-like: a binder macro`("(lambda (formals expr) expr)", {
      macroAttribute: "binder",
    });
    expect(binder.macroAttribute).toBe("binder");
  });
});
