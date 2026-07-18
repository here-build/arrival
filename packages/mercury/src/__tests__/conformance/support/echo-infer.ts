/**
 * Deterministic "echo" inference — the interpreter/compiled parity oracle for the
 * W2 conformance corpus. The agreement law checks the COMPILER (compiled-output ≡
 * `runProgram`), never model quality, so no real backend is exercised here.
 *
 * Precedent: `second-foundation/arrival-chain/src/__tests__/infer-llm-entity.test.ts`'s
 * `recordingBackend` — a `ModelBackend` that "echoes a fixed answer" over the REAL
 * `createInferStore`/`singletonRouter` machinery (no test double for the store
 * itself, just for the backend it dispatches to). This file generalizes that
 * precedent to a value that's a PURE function of (model, prompt, schema) instead of
 * one fixed string, so distinct corpus calls produce distinct-but-stable values —
 * and shares ONE such function between the interpreter path (`createEchoInferStore`,
 * consumed by `run-interpreted.ts`) and the compiled path (the plain functions
 * below, consumed by `run-compiled.ts`'s injected globals), so there is exactly one
 * place that could make the two runtimes disagree about what `(infer …)` returns.
 */
import { createInferStore, type InferStoreLike, singletonRouter } from "@inhuman.tools/llm-plane";
import type { Completion, ModelBackend, ModelSpec } from "@inhuman.tools/llm-plane-protocol";
import { z } from "zod";

/** FNV-1a, 32-bit — the repo's idiom for a cheap deterministic content digest (see
 *  e.g. `../../strategy/hash.ts::fnv1a`, `foundations/arrival/arrival/src/provenance/
 *  wireframe/hash.ts::fnv1a`). A fresh ~6-line copy rather than an import: the
 *  strategy one is private to that module (not exported), and independent copies of
 *  this exact function are already the established idiom across the repo, not drift. */
function fnv1a(str: string): string {
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Mirrors `llm-plane-arrival-env/src/infer.ts::stripSymbolMarker` exactly — strips
 *  the interpreter's scheme-symbol egress marker (`ASymbol["arrival/toJS"]`'s leading
 *  `'`) from a schema value's array elements before it becomes part of the content
 *  key. A no-op on THIS (compiled) side's raw values today — mercury's compiled
 *  codegen never emits the marker (`lower.ts::lowerQuote` lowers a quoted symbol to a
 *  bare JS string) — but kept as an exact mirror rather than an asymmetric skip: the
 *  interpreter side's `schemaSlot` strips it, so this side must apply the same
 *  normalization to stay byte-identical, not merely "happen to already agree." */
function stripSymbolMarker(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(stripSymbolMarker);
  return typeof v === "string" && v.startsWith("'") ? v.slice(1) : v;
}

/**
 * Mirror an emitted zod schema (types/schema-zod, W3) back onto the SOURCE's
 * tagged-list form — the exact array `schemaSlot` stringifies on the interpreter
 * side. The `s/*` vocabulary is closed (schema-tag.ts is its one canonical
 * lowering), so the mirror is total over what mercury can emit; anything else
 * is a loud door. Field keys: mercury emits zod object keys with their SOURCE
 * spelling (never `cleanName`d — the schema names the wire), so `:`-prefixing
 * reconstructs the keyword exactly.
 */
function zodToTag(schema: z.ZodType): unknown {
  if (schema instanceof z.ZodOptional) {
    const inner = zodToTag(schema.unwrap() as z.ZodType);
    if (typeof inner === "string") return `${inner}/optional`;
    if (Array.isArray(inner) && typeof inner[0] === "string") return [`${inner[0]}/optional`, ...inner.slice(1)];
    return inner;
  }
  if (schema instanceof z.ZodString) return "s/string";
  if (schema instanceof z.ZodNumber) return "s/number";
  if (schema instanceof z.ZodBoolean) return "s/boolean";
  if (schema instanceof z.ZodEnum) return ["s/enum", ...schema.options];
  if (schema instanceof z.ZodArray) return ["s/array", zodToTag(schema.element as z.ZodType)];
  if (schema instanceof z.ZodObject) {
    const out: unknown[] = ["s/object"];
    for (const [key, field] of Object.entries(schema.shape)) {
      out.push(`:${key}`, zodToTag(field as z.ZodType));
    }
    return out;
  }
  throw new Error("echo-infer: zodToTag — unsupported zod node; extend the mirror alongside types/schema-zod");
}

/**
 * Normalize a schema argument to the single string the REAL wire uses for its
 * content key (`schemaSlot`, `foundations/llm-plane/llm-plane-arrival-env/src/
 * infer.ts`): absent/false/null → null; a string → itself; anything else →
 * `stripSymbolMarker` then JSON.stringify. MUST match `schemaSlot` exactly: the
 * interpreter path receives an already-normalized `ModelSpec.schema` (schemaSlot ran
 * before `configuration.infer` was ever called), while the COMPILED path hands this
 * function the raw JS value — since W3's `types/schema-zod`, the emitted NAMED ZOD
 * SCHEMA constant, mirrored back onto the source's tagged-list form by
 * {@link zodToTag} before the shared stringify. Without this normalization a
 * schema-carrying row would diverge between interpreter and compiled runs for a
 * reason that has nothing to do with the compiler under test — see `schemaSlot`'s
 * own `stripSymbolMarker` doc for why the marker itself is representation noise,
 * not schema-carrying signal.
 */
export function normalizeSchema(v: unknown): string | null {
  if (v === undefined || v === false || v === null) return null;
  if (typeof v === "string") return v;
  if (v instanceof z.ZodType) return JSON.stringify(zodToTag(v));
  return JSON.stringify(stripSymbolMarker(v));
}

/** Mirrors `llm-plane-arrival-env/src/infer.ts::canonicalizeMessages` exactly — the
 *  wire string `infer/chat` folds its `(role content)` message list into. The
 *  interpreter calls the real one over the scheme list; the compiled side calls
 *  THIS over the JS array `inferChatSystem`/`inferChatUser`/`inferChatAssistant`
 *  produce (`run-compiled.ts`'s shim, itself a byte-for-byte port of the scheme
 *  prelude in `infer.ts`: `(list "system" content)` etc). Same shape in, same
 *  string out, on both runtimes. */
export function canonicalizeMessages(messages: readonly (readonly [unknown, unknown])[]): string {
  return JSON.stringify(messages.map(([role, content]) => ({ role: String(role), content: String(content) })));
}

/**
 * THE oracle. Pure function of (model, prompt, normalized-schema) — no randomness,
 * no clock, no I/O, no network. Both runtimes must land on the exact same digest
 * for the same triple, or the corpus row isn't testing what it claims to.
 *
 * Return-shape ruling — the W2 "schema-constrained infer: decoded object or JSON
 * string?" flag (design doc §5), resolved empirically, not guessed. See
 * `../schema-infer-probe.test.ts` for the full citation: real backends
 * (`llm-plane-backends/src/backends/_shared.ts::parseModelValue`) `JSON.parse` a
 * schema'd completion's text BEFORE it ever becomes `Completion.value` — a host's
 * `InferFn` never sees raw JSON text for a schema'd call, only the decoded object.
 * PINNED: schema present ⇒ this oracle returns an object, never a JSON string.
 */
export function echoInferValue(model: string, prompt: string, schema: string | null): unknown {
  const digest = fnv1a(JSON.stringify([model, prompt, schema]));
  return schema === null ? `echo:${model}:${digest}` : { echo: true, model, digest };
}

/** A `ModelBackend` whose `.complete` is `echoInferValue` — no network, no clock,
 *  single-flight-cached (same content tuple ⇒ same cell) by the REAL `InferStore`
 *  it's wired into below, exactly as `recordingBackend` is in `infer-llm-entity.
 *  test.ts`. `ModelSpec.schema` arrives PRE-normalized (schemaSlot already ran, in
 *  `infer.ts`'s rosetta glue, before `configuration.infer` was ever called) — no
 *  `normalizeSchema` call needed on this side. */
export const echoModelBackend: ModelBackend = {
  async complete(spec: ModelSpec): Promise<Completion> {
    return { value: echoInferValue(spec.model, spec.prompt, spec.schema) };
  },
};

/** The interpreter-side plane: every model name routes to {@link echoModelBackend}
 *  (the `singletonRouter` precedent from `infer-llm-entity.test.ts`), through the
 *  REAL `InferStore` — single-flight caching included, so the agreement law also
 *  covers cell dedup, not just value shape. Fresh per call: each corpus row gets
 *  its own store, so no cross-row cache bleed. */
export function createEchoInferStore(): InferStoreLike {
  return createInferStore(singletonRouter(echoModelBackend));
}
