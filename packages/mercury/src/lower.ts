/**
 * The lowering walk: scheme `Node` forest → naive JS expression/statement strings.
 * Structure-preserving and total over the forms the example chains use; anything
 * outside that set throws an explicit "unsupported in read-view" error (a door,
 * not a silent miss). Faithful to the parse tree it is GIVEN — a malformed source
 * projects to malformed-but-isomorphic JS; the projection never invents structure.
 */
import { reachesAsync } from "./async-analysis.js";
import { cleanName, containsAwaitToken, destructureTuple } from "./names.js";
import {
  type Atom,
  head,
  isAtom,
  isBool,
  isKeyword,
  isList,
  isNil,
  isNumber,
  keywordName,
  type ListNode,
  type Node,
} from "./nodes.js";
import {
  CHAT_MESSAGE_CTOR_VERBS,
  chatMessageClassOf,
  lowerLangchainInferCall,
  lowerLangchainMessageTuple,
} from "./rt-langchain.js";
import { lowerVercelInferCall, lowerVercelMessageTuple, VERCEL_MESSAGE_ROLES } from "./rt-vercel-ai.js";
import { type Emit, STDLIB, accessorJs } from "./stdlib.js";
import { hasOpinion, type Strategy } from "./strategy/index.js";
import { isInferCall, type TypeInfo } from "./type-infer.js";

export interface LowerCtx {
  /** Inline `(require "p")` (nested in an expression) → its hoisted import local. */
  requireSubst: Map<string, string>;
  /** The writing strategy — present iff run-view (async, strategy-driven); `undefined`
   *  in read-view (sync, legible, no runtime calls). Every former `ctx.target ===
   *  "run"` check reads `ctx.strategy !== undefined` instead — the record IS the
   *  boolean now (design doc §7). */
  strategy: Strategy | undefined;
  /** The type-analysis plane (run-view only): signatures, domain shapes, s/*→zod
   *  schemas, entry preconditions. `undefined` in read-view. */
  types: TypeInfo | undefined;
  /** Cleaned `define` names that must be `async` (run-view). */
  asyncNames: Set<string>;
  /** Cleaned `.prompt`-require locals — the async inference primitives (run-view). */
  inferReqs: Set<string>;
  /** Scope-resolved JS name per BOUND identifier occurrence (binding and ref), from the
   *  lexical namer (#76). Absent for free refs / stdlib → fall back to `cleanName`.
   *  Both EMIT and the PARAM-scope await machinery (`inParams`) use this resolved name, so
   *  a call's await decision matches what's emitted; the GLOBAL `asyncNames`/`inferReqs`
   *  sets stay `cleanName`-keyed (async-analysis builds them on cleanNames). For a
   *  collision-free program `nameOf === cleanName`, so output is unchanged. */
  nameOf: Map<Atom, string>;
}

export interface Lowerer extends Emit {
  /** Lower a top-level form: a `define` → `const`, anything else → an expression statement. */
  lowerTop(form: Node): string;
  /** Did any lowering emit an `invariant(…)` precondition (R3)? The assembler
   *  prepends the 5-line `invariant` declaration exactly when this is true. */
  usedInvariant(): boolean;
  /** `ts-vercel-ai` rt/* runtime imports this module's emission actually referenced
   *  — always empty under `ts-langchain` / read-view (the vercel dispatch never
   *  fires there). `assemble.ts` adds the corresponding `import ... from "ai"` /
   *  `from "./runtime/llm.js"` lines exactly when non-empty (rt-vercel-ai.ts owns
   *  the shapes; this is only the usage census). */
  usedVercelRuntime(): { ai: readonly string[]; modelMessage: boolean; models: boolean };
  /** `ts-langchain` rt/* runtime imports this module's emission actually
   *  referenced — always empty under `ts-vercel-ai` / read-view (the langchain
   *  dispatch never fires there). `assemble.ts` adds the corresponding
   *  `import ... from "@langchain/core/messages"` / `from "./runtime/llm.js"`
   *  lines exactly when non-empty (rt-langchain.ts owns the shapes; this is only
   *  the usage census — mirrors `usedVercelRuntime` exactly). */
  usedLangchainRuntime(): { messageClasses: readonly string[]; models: boolean };
}

export function makeLowerer(ctx: LowerCtx): Lowerer {
  // Stack of scheme→js name overrides, used to inline a unary lambda's body in
  // place (e.g., inside `max-by`). Empty in the common case; resolution then falls
  // through to the pure `cleanName`.
  const substStack: Map<string, string>[] = [];

  let usedInvariant = false;
  // ts-vercel-ai usage census (usedVercelRuntime) — see rt-vercel-ai.ts for the
  // shapes; this file only tracks WHICH ones fired, for assemble.ts's imports.
  let vercelGenerateText = false;
  let vercelGenerateObject = false;
  let vercelModelMessage = false;
  let vercelModels = false;
  // ts-langchain usage census (usedLangchainRuntime) — see rt-langchain.ts for the
  // shapes; this file only tracks WHICH ones fired, for assemble.ts's imports.
  // Canonical order (System, Human, AI) — not Set-iteration/call-site order — so
  // the emitted import list is deterministic regardless of which call happened
  // to fire first (the repo's determinism law: same input, same bytes).
  const langchainMessageClasses = new Set<string>();
  let langchainModels = false;

  /** Does `strategy` carry `id`? All opinion-gated emission reads the record —
   *  never a fresh boolean (W1's threading discipline, design doc §7). */
  const opted = (id: Parameters<typeof hasOpinion>[1]): boolean =>
    ctx.strategy !== undefined && hasOpinion(ctx.strategy, id);

  /** The EMITTED JS name for a bound identifier occurrence: the namer's assignment, or
   *  `cleanName` for a free ref / global / stdlib (absent from `nameOf`). */
  const emitName = (a: Atom): string => {
    // naming/reserved-double-underscore: `__` is the emitted runtime's own glue
    // sigil (mirroring here.build's `__hb_` rejection); user identifiers can
    // neither collide with nor impersonate it.
    if (opted("naming/reserved-double-underscore") && a.atom.startsWith("__")) {
      throw new Error(
        `\`${a.atom}\`: the \`__\` prefix is reserved for emitted-runtime glue ` +
          `(naming/reserved-double-underscore) — rename the identifier`,
      );
    }
    return ctx.nameOf.get(a) ?? cleanName(a.atom);
  };

  /** Resolve an identifier atom to its emitted name. An inline-lambda substitution
   *  (max-by) wins; then the scope-resolved name; then `cleanName`. */
  const resolveRef = (a: Atom): string => {
    for (let i = substStack.length - 1; i >= 0; i--) {
      const hit = substStack[i]!.get(a.atom);
      if (hit !== undefined) return hit;
    }
    return emitName(a);
  };
  /** Param-list form: the scope-resolved name (`emitName`). Both the emitted arrow AND the
   *  await machinery (`inParams`) use this same resolved name — so a call's await decision
   *  matches what's emitted. (Using `cleanName` for the await side instead would conflate a
   *  global predicate `picked?` with an in-scope param `picked`: both clean to `picked`, so
   *  the predicate call would be spuriously awaited. They agree only for collision-free names.) */
  const emitParam = (p: { atom: Atom; rest: boolean }): string =>
    p.rest ? `...${emitName(p.atom)}` : emitName(p.atom);

  const lower = (n: Node): string => (isAtom(n) ? lowerAtom(n) : isList(n) ? lowerList(n) : "undefined");

  const lowerWith = (bindings: Record<string, string>, body: Node): string => {
    substStack.push(new Map(Object.entries(bindings)));
    try {
      return lower(body);
    } finally {
      substStack.pop();
    }
  };

  // Lexical params in scope. A call to a function-valued param is conservatively
  // awaited in the run-view (it might be an async fn passed in; await on a
  // non-Promise is a no-op, so over-awaiting is safe).
  const paramStack: Set<string>[] = [];
  const inParams = (name: string): boolean => paramStack.some((s) => s.has(name));
  const withParams = (params: string[], body: () => string): string => {
    paramStack.push(new Set(params));
    try {
      return body();
    } finally {
      paramStack.pop();
    }
  };

  // Is this function node async (run-view)? An async-named fn / infer primitive, or a
  // lambda whose body reaches one.
  const isAsyncFn = (node: Node): boolean => {
    if (ctx.strategy === undefined) return false;
    if (isAtom(node) && !node.str) {
      const c = cleanName(node.atom);
      return ctx.asyncNames.has(c) || ctx.inferReqs.has(c);
    }
    if (isList(node) && head(node) === "lambda") return reachesAsync(node, ctx.asyncNames, ctx.inferReqs);
    return false;
  };

  const E: Emit = { lower, lowerWith, strategy: ctx.strategy, isAsyncFn };

  function lowerAtom(a: Atom): string {
    if (a.str) return JSON.stringify(decodeString(a.atom));
    if (isBool(a)) return a.atom === "#t" ? "true" : "false";
    if (isNumber(a)) return a.atom;
    // A bare `:keyword` in value position is meaningless (it's only an accessor head
    // or a kwarg marker). Checked inline: `a` is already `Atom`, so the `isKeyword`
    // guard would narrow the else-branch to `never`.
    if (!a.str && a.atom.length > 1 && a.atom.startsWith(":")) {
      throw new Error(`bare keyword in expression position: ${a.atom}`);
    }
    return resolveRef(a);
  }

  function lowerList(n: ListNode): string {
    if (isNil(n)) return "[]";
    const h = n.list[0];

    // A :keyword in HEAD position is an ACCESSOR: (:field obj) → obj.field.
    // (A :keyword in ARGUMENT position is a kwarg — handled in lowerCall.)
    if (isKeyword(h)) {
      const obj = n.list[1];
      if (!obj) throw new Error(`accessor ${h.atom} with no operand`);
      return `${recv(lower(obj))}.${keywordName(h)}`;
    }

    const hName = isAtom(h) && !h.str ? h.atom : undefined;

    // infer/scalar-fold: `(car (infer …))` folds to the bare awaited value — the
    // list wrapper is interpreter plumbing (`inferList` wraps "to a list for
    // scheme"), not a source concept. A non-`car`'d infer materializes faithfully
    // as `[value]`.
    if (opted("infer/scalar-fold")) {
      if (hName === "car" && n.list.length === 2 && isInferCall(n.list[1])) return lowerInferCall(n.list[1]);
      if (isInferCall(n)) return `[${lowerInferCall(n)}]`;
    }

    // rt/chat-messages (ts-vercel-ai): the `infer/chat/system|user|assistant` tuple
    // constructors lower to typed message literals, never a call to a bare
    // `inferChatSystem` identifier (that's the read-view / pre-registry fallback
    // further below, unchanged).
    if (
      ctx.strategy?.id === "ts-vercel-ai" &&
      opted("rt/chat-messages") &&
      hName !== undefined &&
      hName in VERCEL_MESSAGE_ROLES
    ) {
      vercelModelMessage = true;
      return lowerVercelMessageTuple(hName, n.list.slice(1), { lower });
    }

    // rt/chat-messages (ts-langchain): the same tuple constructors lower to
    // langchain's own message classes — same fill-time slot, symmetric to the
    // vercel branch above (design doc §3: "the runtime axis is ONE axis... read
    // at the infer-lowering slot"), never a cross-product special case.
    if (
      ctx.strategy?.id === "ts-langchain" &&
      opted("rt/chat-messages") &&
      hName !== undefined &&
      CHAT_MESSAGE_CTOR_VERBS.has(hName)
    ) {
      const cls = chatMessageClassOf(hName);
      if (cls !== undefined) langchainMessageClasses.add(cls);
      return lowerLangchainMessageTuple(hName, n.list.slice(1), { lower });
    }

    if (hName !== undefined) {
      switch (hName) {
        case "quote":
          return lowerQuote(n.list[1]);
        case "lambda":
          return lowerLambda(n);
        case "if":
          return lowerIf(n);
        case "let":
        case "let*":
          return lowerLet(n);
        case "begin":
          return iife(lowerSequence(n.list.slice(1), "{", "}"));
        case "require": {
          const path = pathOf(n.list[1]);
          const local = ctx.requireSubst.get(path);
          if (local === undefined) throw new Error(`unresolved inline require: ${path}`);
          return local;
        }
        case "define":
          throw new Error("internal `define` is unsupported in read-view (run-view concern)");
        // cond / when / unless are expanded to `if` in the desugar pre-pass; `case` doors there.
      }
      const emit = STDLIB[hName];
      if (emit) return emit(n.list.slice(1), E);
      // pair-accessor catchall (car/cdr/cadr/caddr AND mixed caar/cdar/caadr/…).
      if (n.list.length === 2) {
        const acc = accessorJs(hName, lower(n.list[1]!));
        if (acc !== null) return acc;
      }
    }

    return lowerCall(h!, n.list.slice(1));
  }

  /**
   * An infer-family verb call, lowered per the run register: awaited, cache-key
   * elided (`infer/cache-key-elide` — the content key is the interpreter's
   * provenance economy, not an artifact concern), and — when `types/schema-zod`
   * materialized the quoted `s/*` contract — the schema argument replaced by the
   * named zod schema constant, so the call and the domain type share one origin.
   */
  function lowerInferCall(call: ListNode): string {
    const verb = (call.list[0] as Atom).atom;
    const args = call.list.slice(1);
    // rt/plain-infer · rt/chat-messages · rt/structured-output (ts-vercel-ai): the
    // runtime-axis fill-time slot (design doc §3/§7 pipeline) — everything below
    // this branch is the read-view / pre-registry shape, untouched.
    if (ctx.strategy?.id === "ts-vercel-ai") {
      vercelModels = true;
      const { code, usesGenerateObject } = lowerVercelInferCall(verb, args, {
        lower,
        schemaConstOf: (node) => ctx.types?.schemaConstOf(node),
      });
      if (usesGenerateObject) vercelGenerateObject = true;
      else vercelGenerateText = true;
      return code;
    }
    // rt/plain-infer · rt/chat-messages · rt/structured-output (ts-langchain): the
    // SAME fill-time slot, symmetric to the vercel branch above — one lowering
    // core, the runtime axis read inline, no forked emitter pair (design doc §1
    // table row 4 / §3).
    if (ctx.strategy?.id === "ts-langchain") {
      langchainModels = true;
      const { code } = lowerLangchainInferCall(verb, args, {
        lower,
        schemaConstOf: (node) => ctx.types?.schemaConstOf(node),
      });
      return code;
    }
    let parts: string[];
    if (verb === "infer/agentic/end-to-end") {
      parts = args.map((a) => lower(a)); // (model msgs servers) — no schema/cacheKey slots
    } else {
      parts = args.slice(0, 2).map((a) => lower(a)); // model, prompt/messages
      const schema = args[2];
      if (schema !== undefined && !(isAtom(schema) && !schema.str && schema.atom === "#f")) {
        parts.push(ctx.types?.schemaConstOf(schema) ?? lower(schema));
      }
      // args[3+] (cacheKey, params) elided — infer/cache-key-elide, by name.
    }
    return `await ${cleanName(verb)}(${parts.join(", ")})`;
  }

  function lowerCall(fn: Node, args: Node[]): string {
    const positional: Node[] = [];
    const kwargs: [string, Node][] = [];
    let i = 0;
    while (i < args.length && !isKeyword(args[i])) positional.push(args[i++]!);
    while (i < args.length) {
      const k = args[i]!;
      if (!isKeyword(k)) throw new Error(`positional argument after keyword: ${describe(k)}`);
      const v = args[i + 1];
      if (v === undefined) throw new Error(`keyword ${k.atom} has no value`);
      kwargs.push([keywordName(k), v]);
      i += 2;
    }
    // `headName` (cleanName) keys the GLOBAL sets (`inferReqs`/`asyncNames`, built by
    // async-analysis on cleanNames); `headEmit` (scope-resolved) keys the PARAM scope so a
    // call's await decision matches what's emitted — a predicate `picked?` is `isPicked`
    // here, never confused with an in-scope param `picked` (both clean to `picked`).
    const headName = isAtom(fn) && !fn.str ? cleanName(fn.atom) : undefined;
    const headEmit = isAtom(fn) && !fn.str ? emitName(fn) : undefined;
    // Keyword → a valid JS identifier key (`:max-words` → `maxWords`), same cleaning
    // as every other identifier (a hyphen would be an invalid unquoted object key).
    const kwObj = `{ ${kwargs.map(([k, v]) => `${cleanName(k)}: ${lower(v)}`).join(", ")} }`;
    // run-view inference call: await, and take ONLY the inputs object — the content
    // cache-key the read-view keeps is the runtime's concern, not ax's.
    if (ctx.strategy !== undefined && headName !== undefined && ctx.inferReqs.has(headName)) {
      return `await ${lower(fn)}(${kwargs.length > 0 ? kwObj : ""})`;
    }
    const argStrs = positional.map((p) => lower(p));
    if (kwargs.length > 0) argStrs.push(kwObj);
    // A lambda in CALL-HEAD position must be parenthesized — `((compose f g) 3)`
    // desugars to an immediate lambda call, and an unwrapped arrow would parse as
    // `(it) => f(g(it))(3)` (a bare, never-invoked function literal — the W2
    // conformance report's compiler bug). An async immediate lambda is awaited
    // inline for the same reason the async IIFE is (see `iife`).
    const fnStr = lower(fn);
    const lambdaCallee = isList(fn) && head(fn) === "lambda";
    const callee = lambdaCallee ? `(${fnStr})` : fnStr;
    const call = `${callee}(${argStrs.join(", ")})`;
    if (lambdaCallee && fnStr.startsWith("async ")) return `await ${call}`;
    if (
      ctx.strategy !== undefined &&
      headName !== undefined &&
      (ctx.asyncNames.has(headName) || (headEmit !== undefined && inParams(headEmit)))
    ) {
      return `await ${call}`;
    }
    return call;
  }

  /**
   * `topLevel` marks a lambda that IS a top-level define's value — under
   * `types/explicit-signatures` it gets the full signature treatment (param types
   * with honest-`unknown` fallback + return type), same as a `(define (f …) …)`.
   * Inner lambdas are annotated only where the type plane knows something —
   * a bare param stays bare and picks up its contextual type from the receiver.
   */
  function lowerLambda(n: ListNode, topLevel = false): string {
    const annotate = opted("types/explicit-signatures");
    const ps = paramAtoms(n.list[1]);
    const body = withParams(ps.map(emitParam), () => lowerBody(n.list.slice(2)));
    const asyncKw = ctx.strategy !== undefined && containsAwaitToken(body) ? "async " : "";
    const emit = ps.map(emitParam);
    // A single tuple param consumed only by index destructures: (pair) => pair[1] === 0
    // becomes ([first, second]) => second === 0.
    if (ps.length === 1 && !(annotate && topLevel)) {
      const d = destructureTuple(emit[0]!, body);
      if (d) return `${asyncKw}(${d.pattern}) => ${d.body}`;
    }
    const params = ps.map((p) => {
      if (!annotate) return emitParam(p);
      const ty = ctx.types?.typeOfBinding(p.atom) ?? (topLevel ? (p.rest ? "unknown[]" : "unknown") : undefined);
      return ty === undefined ? emitParam(p) : `${emitParam(p)}: ${ty}`;
    });
    const ret = annotate && topLevel ? `: ${promiseWrap(ctx.types?.returnTypeOf(n) ?? "unknown", asyncKw !== "")}` : "";
    return `${asyncKw}(${params.join(", ")})${ret} => ${body}`;
  }

  /**
   * Law T (truthiness), run/read-side conservative form: only `#f` is false in
   * Scheme — `0`/`""`/`'()` are truthy — and `#f` lowers to `false` (the
   * representation law), so the exact JS spelling of "Scheme-truthy" is
   * `!== false`. Phase 0 has no type facts, so EVERY condition gets the guard
   * (on a boolean condition it's value-identity); Phase 1's `facts.boolean`
   * narrows back to the bare ternary.
   */
  function lowerIf(n: ListNode): string {
    const [, c, a, b] = n.list;
    const els = b === undefined ? "undefined" : lower(b);
    return `(${lower(c!)} !== false ? ${lower(a!)} : ${els})`;
  }

  /**
   * SRFI-26 `cut` — `(cut proc arg…)` with `<>` slots is a terse lambda: one param
   * per slot, filled left-to-right (the proc position may itself be a slot). Desugar
   * to a synthetic `(lambda (slots…) (proc args…))` and lower THAT, so `apply`,
   * operators, and async detection all flow through the normal call path.
   *   (cut apply max <>)     → (it) => Math.max(...it)
   *   (cut dominates? <> c)  → (it) => dominates(it, c)
   */
  /** The arrow-BLOCK interior of a plain (non-named) let/let*: `{ const x = …; return last; }`. */
  function letBlock(n: ListNode): string {
    const bindings = n.list[1];
    const decls: string[] = [];
    if (isList(bindings)) {
      for (const b of bindings.list) {
        if (isList(b) && isAtom(b.list[0])) decls.push(`const ${emitName(b.list[0])} = ${lower(b.list[1]!)};`);
      }
    }
    return lowerSequence(n.list.slice(2), `{ ${decls.join(" ")}`, "}");
  }

  /** A let binding would collide with a param in scope → keep the IIFE's fresh scope
   *  (unwrapping into the arrow block would be a `const`-redeclares-param error). */
  function letShadowsParam(n: ListNode): boolean {
    const bindings = n.list[1];
    return (
      isList(bindings) && bindings.list.some((b) => isList(b) && isAtom(b.list[0]) && inParams(emitName(b.list[0])))
    );
  }

  /** Wrap a `{ … }` block as an immediately-invoked arrow for EXPRESSION position. When the
   *  block awaits (run-view), the arrow is async AND the call is awaited inline — legal
   *  because any function reaching this point is itself async (it transitively calls infer),
   *  so the value flows correctly in ANY context. A bare `(async () => …)()` would instead
   *  leak a Promise into `1 + …`, `f(…)`, a ternary arm, etc. — the run-view footgun. */
  const iife = (block: string): string =>
    ctx.strategy !== undefined && containsAwaitToken(block) ? `(await (async () => ${block})())` : `(() => ${block})()`;

  function lowerLet(n: ListNode): string {
    if (isAtom(n.list[1])) return lowerNamedLet(n);
    return iife(letBlock(n));
  }

  /**
   * The arrow-BLOCK interior of a named `let`: `{ const loop = (…) => body; return loop(inits); }`.
   * Shared by {@link lowerNamedLet} (wraps it in an IIFE for expression position) and the
   * body-unwrap in {@link lowerBody} (where the enclosing arrow already IS the wrapper, so
   * the IIFE is pure ceremony). The init values are lowered in the OUTER scope, the body in
   * the loop's. Run-view: if the body reaches an inference call it goes async, and a second
   * pass re-lowers with the loop name in scope so its recursive calls await.
   */
  function namedLetBlock(n: ListNode): { block: string; isAsync: boolean } {
    const nameAtom = n.list[1] as Atom;
    const name = emitName(nameAtom);
    const bindings = n.list[2];
    const varAtoms: Atom[] = [];
    const inits: string[] = [];
    if (isList(bindings)) {
      for (const b of bindings.list) {
        if (isList(b) && isAtom(b.list[0])) {
          varAtoms.push(b.list[0]);
          inits.push(b.list[1] === undefined ? "undefined" : lower(b.list[1]));
        }
      }
    }
    const emitParams = varAtoms.map(emitName); // scope-resolved names (emit + await machinery)
    const bodyForms = n.list.slice(3);
    // control/self-tail-loop: a named let whose recursive calls are ALL tail calls
    // lowers to a `while` loop — unbounded iteration without stack growth (the
    // seam-8 TCO obligation, resolved). Any non-tail use falls through to the
    // declared stack-bound arrow below.
    if (opted("control/self-tail-loop") && selfTailOnly(bodyForms, nameAtom.atom)) {
      const decls = varAtoms.map((v, k) => {
        const ty = ctx.types?.typeOfBinding(v);
        const ann = ty === undefined ? "" : `: ${ty}`;
        return `let ${emitName(v)}${ann} = ${inits[k]};`;
      });
      const stmts = withParams(emitParams, () => emitTailForms(bodyForms, nameAtom.atom, emitParams));
      // The fold marker (R4): the one synthetic comment an axis-a rewrite leaves
      // where the reader would otherwise ask "where did my named let go".
      const marker = `// [ts-base/self-tail-loop] named let \`${name}\` → while`;
      const block = `{ ${marker}\n${decls.join(" ")} while (true) { ${stmts} } }`;
      return { block, isAsync: ctx.strategy !== undefined && containsAwaitToken(block) };
    }
    let body = withParams(emitParams, () => lowerBody(bodyForms));
    const isAsync = ctx.strategy !== undefined && containsAwaitToken(body);
    if (isAsync) body = withParams([...emitParams, emitName(nameAtom)], () => lowerBody(bodyForms)); // recursive calls await
    const a = isAsync ? "async " : "";
    const call = `${name}(${inits.join(", ")})`;
    return {
      block: `{ const ${name} = ${a}(${emitParams.join(", ")}) => ${body}; return ${isAsync ? `await ${call}` : call}; }`,
      isAsync,
    };
  }

  /**
   * Named `let` — Scheme's loop primitive — in EXPRESSION position: the block wrapped in
   * an immediately-invoked arrow so it's an expression. At a function's sole-body position
   * {@link lowerBody} unwraps it (the enclosing arrow is the wrapper).
   */
  function lowerNamedLet(n: ListNode): string {
    return iife(namedLetBlock(n).block);
  }

  /**
   * Tail-position statements of a self-tail named let's body, for the `while (true)`
   * lowering: a recursive call becomes a simultaneous param reassignment +
   * `continue`; every other leaf `return`s; `if`/`begin`/`let` distribute over
   * their tail positions ({@link selfTailOnly} has already proven this covers
   * every recursive call).
   */
  function emitTailForms(forms: Node[], loopName: string, params: string[]): string {
    const lead = forms.slice(0, -1).map(lowerStmt);
    return [...lead, emitTailForm(forms.at(-1)!, loopName, params)].join(" ");
  }

  function emitTailForm(form: Node, loopName: string, params: string[]): string {
    if (isList(form)) {
      const hn = head(form);
      if (hn === loopName) {
        const args = form.list.slice(1).map((a) => lower(a));
        const step =
          params.length === 0
            ? ""
            : params.length === 1
              ? `${params[0]} = ${args[0] ?? "undefined"}; `
              : `[${params.join(", ")}] = [${args.join(", ")}]; `; // simultaneous, like the call was
        return `${step}continue;`;
      }
      if (hn === "if") {
        const [, c, a, b] = form.list;
        const els = b === undefined ? "return undefined;" : emitTailForm(b, loopName, params);
        // Same Law T guard as lowerIf — the statement-`if` spelling of the loop
        // lowering is the SECOND condition-emitting site, not an exemption.
        return `if (${lower(c!)} !== false) { ${emitTailForm(a!, loopName, params)} } else { ${els} }`;
      }
      if (hn === "begin") return emitTailForms(form.list.slice(1), loopName, params);
      if ((hn === "let" || hn === "let*") && !isAtom(form.list[1])) {
        const bindings = form.list[1];
        const decls: string[] = [];
        if (isList(bindings)) {
          for (const b of bindings.list) {
            if (isList(b) && isAtom(b.list[0])) decls.push(`const ${emitName(b.list[0])} = ${lower(b.list[1]!)};`);
          }
        }
        return `{ ${decls.join(" ")} ${emitTailForms(form.list.slice(2), loopName, params)} }`;
      }
    }
    return `return ${lower(form)};`;
  }

  /** A named let unwrapped at body position declares `const <loopName>` in the arrow block;
   *  keep the IIFE if that name shadows a param (same-scope const redeclare). */
  function namedLetShadowsParam(n: ListNode): boolean {
    return isAtom(n.list[1]) && inParams(emitName(n.list[1]));
  }

  /** A body statement: an internal `(define …)` → a block-local `const` (Scheme allows
   *  defines at the head of any body); anything else → an expression statement. */
  function lowerStmt(form: Node): string {
    return isList(form) && head(form) === "define" ? lowerDefine(form) : `${lower(form)};`;
  }

  function lowerSequence(forms: Node[], open: string, close: string): string {
    const last = lower(forms.at(-1)!);
    const lead = forms.slice(0, -1).map(lowerStmt);
    return `${open} ${[...lead, `return ${last};`].join(" ")} ${close}`;
  }

  function lowerBody(forms: Node[]): string {
    if (forms.length === 1) {
      const only = forms[0]!;
      // A let/let*/named-let/begin as the SOLE body IS the arrow's own block — drop the
      // IIFE `lowerLet`/`begin` add for expression position (it's pure ceremony here, and
      // unwrapping lets an `await` inside sit in the now-async function, not a nested sync
      // IIFE). Skip one that would shadow a param (same-scope const redeclare).
      if (isList(only)) {
        const h = head(only);
        if ((h === "let" || h === "let*") && !isAtom(only.list[1]) && !letShadowsParam(only)) return letBlock(only);
        if (h === "let" && isAtom(only.list[1]) && !namedLetShadowsParam(only)) return namedLetBlock(only).block;
        if (h === "begin") return lowerSequence(only.list.slice(1), "{", "}");
      }
      // A single object-literal body must be parenthesized so the arrow doesn't
      // read `=> { … }` as a block: `(x) => ({ a: 1 })`, not `(x) => { a: 1 }`.
      const e = lower(only);
      return e.startsWith("{") ? `(${e})` : e;
    }
    return lowerSequence(forms, "{", "}");
  }

  function lowerQuote(datum: Node | undefined): string {
    if (datum === undefined) return "undefined";
    if (isAtom(datum)) {
      if (datum.str) return JSON.stringify(decodeString(datum.atom));
      if (isNumber(datum) || isBool(datum)) return lowerAtom(datum);
      return JSON.stringify(datum.atom); // quoted symbol → string
    }
    if (isList(datum)) return `[${datum.list.map(lowerQuote).join(", ")}]`;
    return "undefined";
  }

  function lowerTop(form: Node): string {
    const lead = leadComments(form);
    let code: string;
    if (isList(form) && head(form) === "define") {
      code = lowerDefine(form, true);
    } else {
      const expr = lower(form); // a top-level expression statement: parenthesize an object
      code = `${expr.startsWith("{") ? `(${expr})` : expr};`; // literal so `{…}` isn't a block
    }
    return lead ? `${lead}\n${code}` : code;
  }

  /**
   * `top` marks a top-level define. Under the run register it gets the full
   * `types/explicit-signatures` treatment (param + return types, honest-`unknown`
   * fallback) and its `invariants/preconditions` entry checks; an internal define
   * gets param annotations (same fallback — an unannotated arrow param is a strict
   * error regardless of context) but no return type (inference is exact there).
   */
  function lowerDefine(n: ListNode, top = false): string {
    const annotate = opted("types/explicit-signatures");
    const sig = n.list[1];
    if (isList(sig)) {
      const nameAtom = isAtom(sig.list[0]) ? sig.list[0] : undefined;
      const name = nameAtom ? emitName(nameAtom) : "_";
      const ps = paramAtoms({ list: sig.list.slice(1) });
      // async-ness keyed by cleanName — matches `asyncNames` (from async-analysis).
      const asyncKw =
        ctx.strategy !== undefined && nameAtom && ctx.asyncNames.has(cleanName(nameAtom.atom)) ? "async " : "";
      let body = withParams(ps.map(emitParam), () => lowerBody(n.list.slice(2)));
      // invariants/preconditions (R3): materialized checks at the function entry
      // where the source's semantics imply them (`max-by` / a seedless fold over a
      // possibly-empty parameter). Messages name the source form and the list.
      const pre = top && opted("invariants/preconditions") ? (ctx.types?.preconditionsOf(n) ?? []) : [];
      if (pre.length > 0) {
        usedInvariant = true;
        const checks = pre
          .map((p) => {
            const listName = emitName(p.param);
            const message = JSON.stringify(`(${p.form} …) requires a non-empty \`${listName}\``);
            return `invariant(${listName}.length > 0, ${message});`;
          })
          .join(" ");
        body = body.startsWith("{") ? `{ ${checks}${body.slice(1)}` : `{ ${checks} return ${body}; }`;
      }
      const params = ps.map((p) => {
        if (!annotate) return emitParam(p);
        const ty = ctx.types?.typeOfBinding(p.atom) ?? (p.rest ? "unknown[]" : "unknown");
        return `${emitParam(p)}: ${ty}`;
      });
      const ret =
        annotate && top && nameAtom
          ? `: ${promiseWrap(ctx.types?.returnTypeOf(nameAtom) ?? "unknown", asyncKw !== "")}`
          : "";
      return `const ${name} = ${asyncKw}(${params.join(", ")})${ret} => ${body};`;
    }
    const name = isAtom(sig) ? emitName(sig) : "_";
    const rhs = n.list[2]!;
    // A top-level define whose value is a lambda IS a top-level function — full
    // signature treatment, same as the `(define (f …) …)` spelling.
    if (top && isList(rhs) && head(rhs) === "lambda") {
      return `const ${name} = ${lowerLambda(rhs, true)};`;
    }
    return `const ${name} = ${lower(rhs)};`;
  }

  return {
    ...E,
    lowerTop,
    usedInvariant: () => usedInvariant,
    usedVercelRuntime: () => ({
      ai: [...(vercelGenerateText ? ["generateText"] : []), ...(vercelGenerateObject ? ["generateObject"] : [])],
      modelMessage: vercelModelMessage,
      models: vercelModels,
    }),
    usedLangchainRuntime: () => ({
      // Canonical order (System, Human, AI), not Set-iteration order — see the
      // `langchainMessageClasses` declaration.
      messageClasses: LANGCHAIN_MESSAGE_CLASS_ORDER.filter((c) => langchainMessageClasses.has(c)),
      models: langchainModels,
    }),
  };
}

/** `@langchain/core/messages` import order — matches `MESSAGE_CTORS`' declaration
 *  order in `rt-langchain.ts` (System, Human, AI), so the emitted import list is
 *  a pure function of WHICH classes fired, never of call-site order. */
const LANGCHAIN_MESSAGE_CLASS_ORDER = ["SystemMessage", "HumanMessage", "AIMessage"] as const;

// ── pure helpers ──────────────────────────────────────────────────────

/** Parenthesize an `await …` before a member access: `(await x).f`. No-op in read-view. */
function recv(s: string): string {
  return /^await\b/.test(s) ? `(${s})` : s;
}

/** Render a return type, `Promise<…>`-wrapped when the function is async. */
function promiseWrap(ty: string, isAsync: boolean): string {
  return isAsync ? `Promise<${ty}>` : ty;
}

/**
 * Is every use of `loopName` in this named-let body a CALL in tail position?
 * True ⇒ the loop lowers to `while (true)` (control/self-tail-loop); any value
 * use, non-tail call, closure capture, or rebinding is a conservative `false`
 * (the declared stack-bound arrow remains, faithfully). A use inside a nested
 * lambda or a nested NAMED let's body is never OUR tail position.
 */
function selfTailOnly(bodyForms: Node[], loopName: string): boolean {
  let ok = true;
  const walk = (n: Node | undefined, tail: boolean): void => {
    if (!ok || n === undefined) return;
    if (isAtom(n)) {
      if (!n.str && n.atom === loopName) ok = false; // the loop used as a VALUE
      return;
    }
    if (!isList(n) || n.list.length === 0) return;
    const h = n.list[0];
    const hn = isAtom(h) && !h.str ? h.atom : undefined;
    if (hn === loopName) {
      if (!tail) {
        ok = false;
        return;
      }
      for (const a of n.list.slice(1)) walk(a, false);
      return;
    }
    switch (hn) {
      case "quote":
        return;
      case "if": {
        walk(n.list[1], false);
        walk(n.list[2], tail);
        walk(n.list[3], tail);
        return;
      }
      case "begin": {
        const body = n.list.slice(1);
        for (const [i, f] of body.entries()) walk(f, tail && i === body.length - 1);
        return;
      }
      case "let":
      case "let*": {
        const named = isAtom(n.list[1]);
        if (named && (n.list[1] as Atom).atom === loopName) {
          ok = false; // rebinding — bail conservatively
          return;
        }
        const bindings = named ? n.list[2] : n.list[1];
        if (isList(bindings)) {
          for (const b of bindings.list) {
            if (isList(b) && isAtom(b.list[0]) && b.list[0].atom === loopName) {
              ok = false; // rebinding
              return;
            }
            if (isList(b)) walk(b.list[1], false);
          }
        }
        const body = n.list.slice(named ? 3 : 2);
        // An inner NAMED let's tail positions belong to the INNER loop, not ours.
        for (const [i, f] of body.entries()) walk(f, !named && tail && i === body.length - 1);
        return;
      }
      case "lambda":
      case "define": {
        // Any use inside a nested function is a capture, not a tail call; a
        // rebinding define shadows. Both walk non-tail — an occurrence bails.
        for (const c of n.list.slice(1)) walk(c, false);
        return;
      }
      default: {
        for (const c of n.list) walk(c, false); // an ordinary call: all operands non-tail
        return;
      }
    }
  };
  for (const [i, f] of bodyForms.entries()) walk(f, i === bodyForms.length - 1);
  return ok;
}

/** Parameter atoms, with a dotted rest `(a b . rest)` flagged. The caller derives the
 *  cleanName form (await machinery) and the scope-resolved emit form. */
function paramAtoms(node: Node | undefined): { atom: Atom; rest: boolean }[] {
  if (!isList(node)) return [];
  const out: { atom: Atom; rest: boolean }[] = [];
  for (let i = 0; i < node.list.length; i++) {
    const p = node.list[i]!;
    if (isAtom(p) && p.atom === ".") {
      const rest = node.list[i + 1];
      if (isAtom(rest)) out.push({ atom: rest, rest: true });
      break;
    }
    if (isAtom(p)) out.push({ atom: p, rest: false });
  }
  return out;
}

function pathOf(node: Node | undefined): string {
  if (isAtom(node) && node.str) return node.atom;
  throw new Error("`require` expects a string path");
}

/** A form's leading `;;` comments (captured by the parser) → `//` lines, preserved for the read-view. */
function leadComments(form: Node): string {
  const lead = (form as { lead?: string[] }).lead;
  if (!lead || lead.length === 0) return "";
  return lead.map((c) => c.replace(/^;+\s?/, "// ")).join("\n");
}

function describe(n: Node): string {
  return isAtom(n) ? n.atom : "(…)";
}

/** Decode a scheme string literal's escapes to runtime chars — the parser stores
 *  them raw (`\n` as backslash+n), so emitting `JSON.stringify(raw)` would double-escape. */
function decodeString(raw: string): string {
  return raw.replaceAll(/\\(.)/g, (_m, c: string) => {
    switch (c) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "0":
        return "\0";
      default:
        return c; // \\ \" and any other escaped char → the char itself
    }
  });
}
