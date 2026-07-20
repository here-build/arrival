// symbol.define / symbol.defineSyntax — the SCHEME-BODIED declaration kinds (per-tag
// factory file assembled into `symbol` by ./index.ts; shared types live in ./_bake.js).
//
// docs/environments.md §SYMBOL-KINDS — the `define`/`defineSyntax` rows (decompose a prelude blob
// into individually-declared, contract-bearing, FV-checked defines); §PRELUDE — Pass-2 binding
// and the FV locality law. These two factories give each define a REAL contract (enforced from
// day one) or a declared `macroAttribute`, replacing the opaque text blob's zero-identity surface.
//
// SCOPE — this file owns the STATIC SHAPE only (name/doc parsing, in/out normalization,
// the callable/constant split, the eager `bodyHash`). What needs the parsed body or the
// assembly's own env (the free-variable law, the eager-forward-reference check, the
// derived-role classification, actually EVALUATING the body and binding the validating
// wrapper) cannot happen at factory-call time — the reader is async and the capability's
// own scope doesn't exist until `apply()` runs. That bake machinery lives in
// `./define-bake.js`, invoked from `../capability.ts`'s two-phase apply arm (see
// define-bake.ts for the full two-phase binding contract).

import { ZodType } from "zod";
import { buildSlotAdopter } from "../../membrane/adopt-spine.js";
import * as z from "../scheme-zod.js";
import {
  isSingleOutput,
  normalizeInputVector,
  normalizeVector,
  parseNameDoc,
  type BakeRuntimeOpts,
  type Contract,
  type DefineSymbolDef,
  type DefineSyntaxSymbolDef,
  type RestSpec,
  type VectorSpec,
} from "./_bake.js";

/** FNV-1a over a prefixed canonical string — same shape as `eval/CompiledResolutionChain
 *  .ts`'s file-private `hashSteps` / `provenance/wireframe/hash.ts`'s `fnv1a` (the crc-v0
 *  precedent: prefix tag + `|`-joined canonical parts, FNV-1a, zero-padded hex). Neither
 *  is importable across this module boundary (`hashSteps` isn't exported; wireframe/hash
 *  addresses a different domain, a graph not a define's body+contract) — a FOURTH copy of
 *  the codebase's ONE content-hash idiom, not a new one. */
function fnv1a(prefix: string, canonical: string): string {
  const tagged = `${prefix}|${canonical}`;
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < tagged.length; i++) {
    h ^= tagged.codePointAt(i) ?? 0;
    h = Math.imul(h, 0x01_00_01_93);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Best-effort STABLE TEXT for a contract's shape ("body + contract's stable text" is the
 *  hash input) — zod schema INSTANCES carry no stable serialization, so this walks to
 *  each leaf's REGISTERED name (`z.lookupName`) where one exists, else its zod
 *  constructor tag. Good enough to distinguish "the contract changed" from "only the
 *  body changed" without a full schema-introspection pass (`bodyHash` is a cache key +
 *  a cross-deploy identity input, not a security boundary). */
function contractText(c: unknown): string {
  if (c instanceof ZodType)
    return z.lookupName(c) ?? String((c as { constructor?: { name?: string } }).constructor?.name ?? "zod");
  if (Array.isArray(c)) return `[${c.map(contractText).join(",")}]`;
  if (c !== null && typeof c === "object") {
    const rec = c as Record<string, unknown>;
    if ("input" in rec && "output" in rec) {
      return (
        `input:${contractText(rec.input)}` +
        `|inputRest:${rec.inputRest === undefined ? "-" : contractText(rec.inputRest)}` +
        `|output:${contractText(rec.output)}` +
        `|provenance:${String(rec.provenance ?? "")}`
      );
    }
    // A plain kwargs-shape record (`inputRest`'s OTHER arm) — schema per key, sorted
    // for determinism (object key order isn't part of the contract's meaning here).
    return Object.entries(rec)
      .map(([k, v]) => `${k}:${contractText(v)}`)
      .toSorted((a, b) => a.localeCompare(b))
      .join(",");
  }
  return String(c);
}

/** The two `symbol.define` overloads (the discriminator is the SAME sound
 *  `instanceof z.ZodType` split `RestSpec` already uses): a `Contract<I,O,Rest>`
 *  record authors a PROCEDURE (contract-enforced callable, bound as a validating
 *  wrapper at bake); a bare `ZodTypeAny` authors a CONSTANT (a single value schema,
 *  validated ONCE at bake, bound as a plain value — no wrapper). */
type DefineFactory = {
  <const I extends VectorSpec, const O extends VectorSpec, const Rest extends RestSpec = undefined>(
    contract: Contract<I, O, Rest>,
    body: string,
    opts?: BakeRuntimeOpts,
  ): DefineSymbolDef;
  <const S extends z.ZodTypeAny>(contract: S, body: string, opts?: BakeRuntimeOpts): DefineSymbolDef;
};

/** `symbol.define\`name: description\`(contract, bodyString)` — a scheme-bodied
 *  value/procedure declaration. `bodyString` is the RHS EXPRESSION (a
 *  `(lambda …)` for a procedure, a plain expression for a constant) — never a whole
 *  `(define name …)` form, so the name lives in exactly one place (the tagged
 *  template), matching every other kind's `parseNameDoc` convention. */
export function define(tpl: TemplateStringsArray, ...sub: unknown[]): DefineFactory {
  const { name, doc } = parseNameDoc(tpl, sub);
  const impl = (
    contract: Contract<VectorSpec, VectorSpec, RestSpec> | z.ZodTypeAny,
    body: string,
    opts: BakeRuntimeOpts = {},
  ): DefineSymbolDef => {
    const isConstant = contract instanceof ZodType;
    // Constants normalize to the 0-ary-procedure convention: `in` = the empty
    // vector, `out` = a 1-tuple wrapping the single value schema — so every OTHER
    // vector-shaped reader (harvest, arity) never special-cases a constant
    // structurally; only `callable` (below) tells capability.ts's bind arm which
    // runtime shape to build.
    const inSchema = isConstant ? normalizeVector([]) : normalizeInputVector(contract.input, contract.inputRest);
    const outSchema = isConstant ? normalizeVector([contract]) : normalizeVector(contract.output);
    const bodyHash = fnv1a("symbol.define-v0", `${name}|${body}|${contractText(contract)}`);
    const procedureContract = isConstant ? undefined : (contract as Contract<VectorSpec, VectorSpec, RestSpec>);
    return {
      kind: "define",
      name,
      doc,
      in: inSchema,
      out: outSchema,
      callable: !isConstant,
      singleOut: isConstant ? true : isSingleOutput(procedureContract!.output),
      body,
      bodyHash,
      // Placeholder — the RESOLVED role is DERIVED at bake, over the whole
      // capability's define set, which does not exist until `apply()` runs. Never
      // read before bake: `define-bake.ts` builds a per-assembly DERIVED COPY of
      // this def (`{...def, provenance: derivedRole}`) for whatever gets bound and
      // stamped onto the callable — this singleton object is never mutated (the
      // same "never mutate the shared declaration" convention `capability.ts`'s
      // door bind arm already follows for `DoorCause`).
      provenance: "pipe",
      // A constant has no argument slots to adopt; a procedure adopts per its AUTHORED input list.
      adoptArgs: isConstant ? undefined : buildSlotAdopter(procedureContract!.input, procedureContract!.inputRest),
      declaredProvenance: procedureContract?.provenance,
      type: procedureContract?.type,
      preludeOnly: procedureContract?.preludeOnly,
      validate: opts.validate !== false,
      // The extension bag — data only; dynamic fields resolve at read time, never at bake.
      metadata: opts.metadata,
    };
  };
  return impl as DefineFactory;
}

/** `symbol.defineSyntax\`name: description\`(bodyString, opts?)` — a scheme-bodied
 *  macro/expander declaration, `symbol.define`'s sibling kind. Contract-FREE (a macro
 *  has no call-boundary contract, no provenance role); carries the ternary
 *  `macroAttribute` static attribute instead. `bodyString` is a scheme LAMBDA
 *  expression over the macro's OWN fexpr formals (`(lambda (formals expr . body) …)`
 *  for `receive`) — wound into a `Macro` fexpr transformer at bind time. */
export function defineSyntax(tpl: TemplateStringsArray, ...sub: unknown[]) {
  const { name, doc } = parseNameDoc(tpl, sub);
  return (body: string, opts: { macroAttribute?: "opaque" | "expression" | "binder" } = {}): DefineSyntaxSymbolDef => ({
    kind: "define-syntax",
    name,
    doc,
    body,
    bodyHash: fnv1a("symbol.defineSyntax-v0", `${name}|${body}`),
    // "opaque" is the DEFAULT — under-report, never guess: an unaudited macro's
    // interior contributes nothing to any FV/arity bucket rather than risk a false
    // "unbound" on a legal program.
    macroAttribute: opts.macroAttribute ?? "opaque",
  });
}
