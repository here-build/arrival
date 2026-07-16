/**
 * The infer-family idioms — the opening pair (constitution §3.5/§6/§9 Phase-2
 * opening), now DECISION FUNCTIONS (engine plan §2 E2: "CSE and the peephole
 * pair become sharing/idiom decision views… decided pre-census"), not a
 * `Peephole` table entry. `../model/model.ts`'s `sm.idiomAt(node)` is the one
 * caller — a per-node query the WALKER consults inline (`walker/walk.ts`'s
 * `lowerApp`), never a whole-tree rewrite pass. `../peepholes/index.ts`
 * composes these two into that single decision, including the recursive
 * bottom-up ordering (cache-key-elide on the inner call must be visible to
 * the outer scalar-fold) — see that module's header.
 *
 * Both rewrites are grounded against `arrivalInferCapability`
 * (inhuman/foundations/llm-plane-arrival-env/src/infer.ts) — the REAL contract
 * arrival-mercury compiles against — not against mercury's legacy
 * `lower.ts`/`rt-langchain.ts` behavior, which differs in one load-bearing way
 * (see cache-key-elide's doc below). Both verbs it declares share one shape:
 *
 *   (infer      model prompt   schema? cacheKey?) : List<string>
 *   (infer/chat model messages schema? cacheKey?) : List<string>
 *
 * `output: [z.value]` — a ONE-ELEMENT list wrapping the single completion
 * (`inferList` in llm-plane-arrival-env/src/infer.ts: "wrap an infer result
 * into the scheme list the verbs return"). `#f` is the canonical "omit this
 * optional argument" sentinel for BOTH `schema` and `cacheKey` (`nullable`/
 * `schemaSlot` in the same file: "a scheme `#f` crosses the membrane as JS
 * `false`; treat it, `null`, and `undefined` uniformly as absent").
 */
import type { App, CoreForm, NodeId, Ref } from "../coreform/types.js";

/**
 * Every registry symbol name either idiom below keys its decision on. Used
 * ONLY by index.ts's whole-program shadowing guard (see that module's header)
 * — NOT read by the decision functions themselves, which stay pure per-node
 * predicates per Law C.
 */
export const INFER_PEEPHOLE_LOAD_BEARING_NAMES: readonly string[] = ["car", "infer", "infer/chat"];

/** The two verbs whose Contract shape (`arrivalInferCapability`) supports both
 *  rewrites: a `[model, prompt|messages, schema?, cacheKey?]` positional
 *  arg list, output a one-element list. `infer/chat/system|user|assistant`
 *  are excluded on purpose — they are plain `(role content)` tuple
 *  constructors (a DIFFERENT contract shape, `input: [z.string]` / `output:
 *  [chatMessageSchema]`), never LLM calls, so neither "the list wraps a
 *  completion" nor "position 3 is a cache key" applies to them. */
const SCALAR_TARGET_OF: Readonly<Record<string, string>> = {
  infer: "infer/scalar",
  "infer/chat": "infer/chat/scalar",
};

const isRef = (n: CoreForm): n is Ref => n.kind === "Ref";
const isApp = (n: CoreForm): n is App => n.kind === "App";
const isFalseLiteral = (n: CoreForm): boolean => n.kind === "Lit" && n.value.kind === "boolean" && n.value.value === false;

// ─── (a) infer-scalar-fold ────────────────────────────────────────────────────────────
//
// `(car (infer …))` folds to the bare scalar read — the one-element list is
// interpreter plumbing ("wrap … into the scheme list the verbs return"), not a
// source concept; a source author writing `(car (infer …))` means "give me the
// completion", not "give me index 0 of a list I don't otherwise touch".
//
// REPRESENTATION CHOICE (mission: "pick the representation that keeps the rule
// sync-shaped and ASYNC-IFY-transparent, document it"): the fused node keeps
// its CALL HEAD but renames it to a DISTINCT registry symbol (`infer/scalar` /
// `infer/chat/scalar`) rather than (a) smuggling a marker through `App.kwargs`
// (kwargs collapse into ONE trailing options ObjectLit before any rule runs —
// walker.ts's `lowerApp` — so a kwarg-shaped marker would either never reach
// the rule at all or leak into the EMITTED call as real-looking-but-meaningless
// JS, violating "human-grade" output) or (b) widening `CoreForm.App` with a new
// out-of-band flag field (Residual/CoreForm are both frozen-small by
// constitution — a new field for one idiom is exactly the "add abstraction
// instead of revealing one" trap). A distinguished head:
//   - is SYNC-SHAPED for free: `phase1Rules["infer/scalar"]` is the exact same
//     `inferRule(verb)` factory every other infer-family entry already uses —
//     `{ call: (args, ctx) => Call(ctx.runtime(verb), args) }`, no new Residual
//     shape, no walker change;
//   - is ASYNC-IFY-transparent for free: the two verb strings are members of
//     `inferAsyncSeeds` — the cascade already keys asyncness off `RuntimeRef`
//     symbol membership in that set, structurally blind to what the symbol
//     name spells;
//   - gives the (future, Phase-2/3) runtime shim a real seam to answer
//     differently (return the bare completion, never wrap it) without any
//     compiler-side branching on "was this folded" — the SYMBOL NAME already
//     carries that fact.
//
// COMPOSITION WITH cache-key-elide (E2b): the OLD bottom-up pass rewrote the
// inner `(infer …)` call's cache-key argument away BEFORE the outer `car`
// fold ever examined it, so the fused node's args were already trimmed. As a
// per-node decision, this function accepts `effectiveInnerOf` — the caller's
// own recursive `idiomAt` lookup, applied to the inner call — instead of
// re-deriving that composition itself; see index.ts's `idiomDecisionAt` for
// the actual wiring (never crossed here — this function never calls back
// into the model).
export function inferScalarFoldAt(
  node: App,
  effectiveInnerOf: (inner: App) => App,
  mintId: () => NodeId,
): App | undefined {
  if (!isRef(node.fn) || node.fn.name !== "car") return undefined;
  if (node.kwargs.length !== 0 || node.positionalArgs.length !== 1) return undefined;
  const arg = node.positionalArgs[0]!;
  if (!isApp(arg) || !isRef(arg.fn) || !Object.hasOwn(SCALAR_TARGET_OF, arg.fn.name)) return undefined;

  const scalarName = SCALAR_TARGET_OF[arg.fn.name]!;
  // The inner call, AFTER its own idiom decision (cache-key-elide) has already
  // applied — matches the OLD pass's bottom-up guarantee that scalar-fold's
  // fused args are already-trimmed.
  const inner = effectiveInnerOf(arg);

  // A brand-new logical node (fusing outer car-App + inner infer-App into
  // one) — mint fresh ids for both the App and its head Ref (see
  // model.ts's idiom-id floor: no single original node honestly owns this
  // identity). The outer call's span covers the whole `(car (infer …))` text;
  // the head Ref keeps the INNER call's own span (where "infer"/"infer/chat"
  // was actually written) — the more useful pointer for any future
  // diagnostic. Source `;;` comments on the outer form are NOT carried
  // forward (there are two candidate owners — outer and inner — and picking
  // either would be arbitrary); this is a documented, deliberate limitation,
  // not an oversight.
  const fn: Ref = { kind: "Ref", id: mintId(), span: arg.fn.span, name: scalarName };
  return {
    kind: "App",
    id: mintId(),
    span: node.span,
    fn,
    positionalArgs: inner.positionalArgs,
    kwargs: inner.kwargs,
  };
}

// ─── (b) cache-key-elide ──────────────────────────────────────────────────────────────
//
// DEVIATION FROM THE MISSION'S OWN PARAPHRASE (reported per the mission's
// "READ … to learn the EXACT semantics" instruction, and again in the final
// report): the mission text says mercury's `lowerInferCall` (lower.ts:317
// area) drops the cache-key argument "whose cache-key arg is the #f sentinel".
// Reading that exact code shows the #f-sentinel CONDITIONAL check at line 317
// is applied to the SCHEMA argument (`args[2]`), not cache-key:
//
//   parts = args.slice(0, 2).map(...);          // model, prompt — ALWAYS kept
//   const schema = args[2];
//   if (schema !== undefined && !(isAtom(schema) && !schema.str && schema.atom === "#f")) {
//     parts.push(...);                          // schema — kept UNLESS it is literally #f
//   }
//   // args[3+] (cacheKey, params) elided — infer/cache-key-elide, by name.
//
// Mercury's actual cache-key behavior is an UNCONDITIONAL drop — `args[3+]` is
// never even inspected, so a caller-supplied real cache key is silently
// discarded exactly like an omitted one. That is mercury's `lower.ts`, a
// throwaway legacy emitter (constitution §9 Phase 0: "knowingly
// throwaway-by-Phase-3"), not a law to inherit uncritically.
//
// What this idiom actually implements — grounded against arrival's OWN
// contract (`arrivalInferCapability`, not mercury) — is the mission's LITERAL
// framing, made correct: `nullable()` in llm-plane-arrival-env/src/infer.ts
// is arrival's real "omitted-cacheKey" law ("a scheme `#f` crosses the
// membrane as JS `false`; treat it, `null`, and `undefined` uniformly as
// absent … so an omitted optional arg and an explicit `#f` both mean no
// cacheKey"). So: drop the cache-key argument ONLY when it is the literal `#f`
// sentinel (arrival's own "no cache key" spelling) — never when it carries a
// real value, which is the one respect in which this is STRICTER (more
// correct) than mercury's blanket drop. A symmetric `schema`-elide idiom
// (mirroring mercury's actual #f-conditional on that slot) is a natural
// Phase-2 companion but is intentionally NOT built here — the mission names
// exactly this pair.
const CACHE_KEY_ARITY = 4; // (model prompt schema cacheKey) — arrivalInferCapability's `type:` annotation
const CACHE_KEY_VERBS: ReadonlySet<string> = new Set(["infer", "infer/chat"]);

/** cache-key-elide's decision for a single App node, or `undefined`. A pure
 *  TRIM of an existing call, not a fusion — keep the SAME id/span (still "the
 *  same infer call", just with one fewer trailing argument). No id minting. */
export function cacheKeyElideAt(node: App): App | undefined {
  if (!isRef(node.fn) || !CACHE_KEY_VERBS.has(node.fn.name)) return undefined;
  if (node.positionalArgs.length !== CACHE_KEY_ARITY) return undefined;
  if (!isFalseLiteral(node.positionalArgs[CACHE_KEY_ARITY - 1]!)) return undefined;
  return { ...node, positionalArgs: node.positionalArgs.slice(0, CACHE_KEY_ARITY - 1) };
}
