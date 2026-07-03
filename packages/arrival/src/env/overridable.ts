// @here.build/arrival/overridable — the `arrival/overridable` capability: `define/overridable`
// is, by default, plain `define` PLUS VALIDATION; the execution environment MAY override the
// value, and exposing that behavior (argv, request props, form fields, configuration) is the
// ENVIRONMENT'S responsibility, never this capability's. It is substrate for generalized
// processing — nothing else.
//
// KNOWN CONTEXTS (named, not exhaustive — every one of these is the HOST's concern, not this
// capability's): a CLI runner exposes argv; an API endpoint exposes validated caller props
// layered under configuration overrides; a programmatic caller supplies `runProgram`'s `params`;
// a notebook's form lens supplies form-field values; an agent supplies tool-call arguments. This
// capability sees NONE of that — only the merged `params` bag (`configuration.params`, validated
// only STRUCTURALLY as `z.record(z.string(), z.unknown())`, supplied at `.lower({ config: {
// params } })` time, or through `exec(src, { capabilities, config })`'s shared config bag, of
// which this capability validates only its own `params` slice).
//
// ── s/* is the only place where types appear explicitly ──────────────────────────────────
//
// "s/* is the only place where types appear explicitly." No parallel tag subsets, no
// hand-rolled lowerings — one type language, one lowering. A
// `define/overridable` type tag is lowered through the SAME `tagToJsonSchema` recursion
// (`../common/schema-tag.js`) every other schema consumer (the OpenAI/Anthropic wire schema,
// arrival-chain's HTTP validator) lowers through, via zod's own `z.fromJSONSchema`. The
// hand-rolled scalar subset this file used to carry (`"string"`/`"number"`/`"boolean"`/a bare
// `("enum" …)` list, its own `tagHead`/`lowerTag`) is GONE — it was a second, narrower type
// language that could silently drift from what the wire schema and the HTTP validator actually
// accept. This capability `deps` on `arrival/schema` (`./schema.js`) so the s/* constructors
// (`s/object`, `s/enum`, …) are bound wherever `arrival/overridable` is applied: a
// `define/overridable` type tag may now be ANY s/* expression — `(s/enum "a" "b")`, a nested
// `(s/object …)`, `(s/optional …)` — not just the old scalar subset.
//
// THE SHAPE — a single runtime verb, no assembly-time materialization dance. `overridable/resolve`
// is an ORDINARY RUNTIME rosetta (the three-piece prelude design `pipeline-input` used —
// preludeOnly fetch + `%pipeline-params` + pure-scheme `%params-ref` — is gone; there is nothing
// assembly-time-only left to bridge). The macro is pure ergonomics over it:
//
//     (define/overridable city "string" "Berlin")
//       ⇒ (define city (overridable/resolve 'city "string" "Berlin"))
//
// `overridable/resolve` reads `configuration.params[name]` if the host supplied one (an
// OVERRIDE); otherwise it falls back to the in-form default. EITHER WAY it lowers `type` to a
// zod schema via `tagToJsonSchema` + `z.fromJSONSchema` — the full s/* language, an inert
// `/optional` suffix tolerated on the head — and `.parse()`s the arriving value. So a bad
// DEFAULT throws exactly as loud as a bad OVERRIDE: this is "plain define plus validation" —
// the form validates WHOEVER supplied the value, in-program author included, not just the host.
//
// Calling `overridable/resolve` directly from user code works too — it's a real runtime verb,
// not a sealed door. Nothing about it needs hiding: it only ever reads the program's OWN params,
// so there is no capability to leak by naming it.
//
// NOT in BASE_PACKS: this is config-bearing (params differ per run), lowered per-consumer —
// unlike core/polyglot/srfi (assembled once into every env), an overridable pack is assembled
// FRESH per run with that run's own host-supplied parameter values.

import { z } from "zod";

import { EnvCapability } from "../common/capability.js";
import { symbol } from "../common/symbol.js";
// The scheme-aware zod vocabulary — only the identity carriers (`sz.value`/`sz.symbol`) are
// needed here (the verb decodes/encodes manually via `schemeToJs`/`jsToScheme`; no codec crossing
// at the contract level).
import * as sz from "../common/scheme-zod.js";
import { jsToScheme, schemeToJs } from "../rosetta.js";
import { stripOptionalSuffix, tagToJsonSchema } from "../common/schema-tag.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { schemaCapability } from "./schema.js";

/** Lower a `define/overridable` type tag — an EVALUATED scheme value, already `schemeToJs`'d
 *  into the canonical JS tagged-list form (a bare string, or an array the s/* constructors
 *  build) — to the zod schema that validates a JS value against it. Routes through the ONE
 *  canonical lowering (`tagToJsonSchema`) + zod's own JSON-Schema reconstruction — the same
 *  bridge arrival-chain's `schemaToZod` uses — so this capability can't drift from either the
 *  wire schema or the s/* authoring surface: EVERY tag the schema DSL can express (object,
 *  array, enum, bare primitive, the `/optional` compositor) is accepted, not just a hand-rolled
 *  scalar subset. A tag `tagToJsonSchema`/`z.fromJSONSchema` can't turn into a real validator
 *  (an unrecognized bare-string type, a malformed shape) DOORS with the binding name — never a
 *  silent passthrough. */
function lowerTag(jsTag: unknown, bindingName: string): z.ZodType {
  try {
    return z.fromJSONSchema(tagToJsonSchema(jsTag) as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    throw new Error(
      `define/overridable ${bindingName}: unrecognized type tag ${JSON.stringify(jsTag)} (${reason}) — expected ` +
        `a bare "string"/"number"/"integer"/"boolean", an ("enum" value...) list, an ("object" (name ` +
        `type)...) or ("array" tag) form (as built by the s/* constructors — see ` +
        `@here.build/arrival/schema), with an optional "/optional" suffix on the head`,
    );
  }
}

/** A short human phrase for a (lowered) type tag, for the error message's "expected …" clause.
 *  Strips the inert `/optional` suffix first (nothing about "did you mean X" should mention a
 *  suffix that carries no meaning at this layer). An enum renders its value list; anything else
 *  (a bare primitive, an object/array composite) falls back to a plain JSON-stringify — legible
 *  for a composite without inventing per-shape English. */
function describeTag(jsTag: unknown): string {
  const stripped = stripOptionalSuffix(jsTag);
  if (typeof stripped === "string") return stripped;
  if (Array.isArray(stripped) && stripped[0] === "enum") return `one of ${JSON.stringify(stripped.slice(1))}`;
  return JSON.stringify(stripped);
}

/** A short, safe rendering of an arrived value for the error message's "got …" clause. */
function describeValue(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** The `arrival/overridable` capability — see the file header for the full design. */
export const overridableCapability = new EnvCapability("arrival/overridable", {
  // `.default({})`: a config-less lower MUST succeed (the shared-config-bag posture — a consumer
  // assembling without params still gets the capability; every in-form default then fires,
  // validated the same as an override would be).
  configuration: { params: z.record(z.string(), z.unknown()).default({}) },
  // s/* (`s/object`/`s/enum`/…) must be BOUND wherever `overridable/resolve` is applied: the
  // `define/overridable` macro splices `type` unquoted, so `(define/overridable x (s/enum "a"
  // "b") default)` evaluates the `(s/enum "a" "b")` CALL in the same env before the rosetta ever
  // sees it. Declaring the dependency (rather than requiring every root-set to list
  // `schemaCapability` itself) means `(s/enum …)` resolves wherever `arrival/overridable` is
  // applied, root-set membership or not — same posture the capability DAG uses everywhere else.
  deps: [schemaCapability],
  symbols: ({ configuration }) => ({
    "overridable/resolve": symbol.rosetta`overridable/resolve: (name: symbol, type: string|list, default: any): any — a host override wins over the in-form default; both are validated against \`type\``(
      { input: [sz.symbol, sz.value, sz.value], output: [sz.value] },
      (nameSym, typeTag, defaultVal) => {
        const bindingName = nameSym.toString();
        const jsTag = schemeToJs(typeTag);
        const zodType = lowerTag(jsTag, bindingName);

        const hasOverride = Object.prototype.hasOwnProperty.call(configuration.params, bindingName);
        const raw = hasOverride ? configuration.params[bindingName] : schemeToJs(defaultVal);
        const source = hasOverride ? "an environment override" : "the in-form default";

        const outcome = zodType.safeParse(raw);
        if (!outcome.success) {
          const followup = hasOverride
            ? "the environment that supplied this value should validate at its own boundary too"
            : "a default must satisfy its own declared type — that's the plain-define-plus-validation floor";
          throw new Error(
            `define/overridable ${bindingName}: expected ${describeTag(jsTag)}, got ${describeValue(raw)} ` +
              `(from ${source}) — ${followup}`,
          );
        }
        return jsToScheme(CONSTANT_CTX, outcome.data);
      },
    ),
  }),
  prelude: `
    (define-macro (define/overridable name type default)
      \`(define ,name (overridable/resolve ',name ,type ,default)))
  `,
});
