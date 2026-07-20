// @inhuman.tools/arrival/overridable — the `arrival/overridable` capability: `define/overridable`
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
// arrival-chain's HTTP validator) lowers through, via zod's own `z.fromJSONSchema`. This
// capability `deps` on `arrival/schema` (`./schema.js`) so the s/* constructors (`s/object`,
// `s/enum`, …) are bound wherever `arrival/overridable` is applied: a `define/overridable`
// type tag may be ANY s/* expression — `(s/enum "a" "b")`, a nested `(s/object …)`,
// `(s/optional …)`.
//
// THE SHAPE — a single runtime verb, no assembly-time materialization dance. `overridable/resolve`
// is an ORDINARY RUNTIME rosetta; nothing assembly-time-only needs bridging. The macro is pure
// ergonomics over it:
//
//     (define/overridable city (s/string) "Berlin")
//       ⇒ (define city (overridable/resolve 'city (s/string) "Berlin"))
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
//
// `macroAttribute: "binder"`, not `"expression"` and not the bare `"opaque"` default — `name`
// is a FORMALS position, not expression space: it is spliced ONLY into `(define ,name …)`'s
// binding-name slot, never read back as a value reference anywhere in the expansion. Walking
// it as ordinary expression space would report the call site's own binding target as
// `unbound-symbol` on every legal program — `(define/overridable city (s/string) "Berlin")`
// would flag `city` unbound before it's ever defined. Distinguished from `cut`/`cute`'s
// `"opaque"` (srfi-26): `<>`/`<...>` are placeholder TOKENS consumed positionally by the
// macro's own expander and never appear, bound or free, in the expansion's output; `name` here
// genuinely BINDS — it is exactly the shape `define`'s own name argument is, just
// macro-mediated. `type`/`default` ARE ordinary expression space (evaluated at the call site,
// e.g. `(s/string)`, `"Berlin"`) — but there is no per-argument-position binding-aware walker
// yet, so the whole call is firewalled identically to `"opaque"` today; `"binder"` is the
// honest classification for when that walker lands, not a behavior change now.
//
// No `symbol.define` entries exist in this pack (one macro, one already-rosetta verb) — the
// bake free-variable check only applies to `def.kind === "define"` entries, so it never runs
// here. `deps: [schemaCapability]` (below) covers `type`'s s/* call at the macro's OWN call
// site — this pack's `defineSyntax` body itself references nothing outside `define`/
// `overridable/resolve`, both resolved without a new edge (`define` is KEYWORD_SYNTAX;
// `overridable/resolve` is this same capability's own sibling, referenced only inside the
// quasiquote — literal data at macro-definition time, an ordinary same-capability reference
// once the expansion itself evaluates).

import { z } from "zod";

import { TypeTagError } from "../errors.js";
import { EnvCapability } from "../common/capability.js";
import { symbol, type CallCtx } from "../common/symbol.js";
// The scheme-aware zod vocabulary — only the identity carrier `sz.value` is needed here (the
// verb decodes/encodes manually via `schemeToJs`/`jsToScheme`; no codec crossing at the contract
// level). NOT `sz.symbol` for the `name` param — see that param's own comment below for why.
import * as sz from "../common/scheme-zod.js";
import { jsToScheme, schemeToJs } from "../membrane/rosetta.js";
import { stripOptionalSuffix, tagToJsonSchema } from "../common/schema-tag.js";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { schemaCapability } from "./schema.js";

/** Lower a `define/overridable` type tag — an EVALUATED scheme value, already `schemeToJs`'d
 *  into the canonical JS tagged-list form (a bare string, or an array the s/* constructors
 *  build) — to the zod schema that validates a JS value against it. Routes through the ONE
 *  canonical lowering (`tagToJsonSchema`) + zod's own JSON-Schema reconstruction — the same
 *  bridge `@inhuman.tools/arrival-schema-zod`'s `schemaToZod` uses (re-exported by arrival-chain,
 *  defined in arrival-schema-zod) — so this capability can't drift from either the
 *  wire schema or the s/* authoring surface: EVERY tag the schema DSL can express (object,
 *  array, enum, bare primitive, the `/optional` compositor) is accepted, not just a hand-rolled
 *  scalar subset. A tag `tagToJsonSchema`/`z.fromJSONSchema` can't turn into a real validator
 *  (an unrecognized bare-string type, a malformed shape) DOORS with the binding name — never a
 *  silent passthrough. */
function lowerTag(jsTag: unknown, bindingName: string): z.ZodType {
  try {
    const json = tagToJsonSchema(jsTag);
    // `tagToJsonSchema` is deliberately LENIENT — an unrecognized shape (an unknown list
    // `kind`, an empty list, a non-string/non-array atom like a bare number) falls through
    // to `{}` rather than throwing (see `schema-tag.ts`'s header). That's correct for the
    // WIRE-SCHEMA/HTTP projections, but `{}` lowers to a PERMISSIVE zod validator
    // (`z.fromJSONSchema({})` accepts anything), which would make `overridable/resolve`
    // silently accept ANY override for such a tag — the exact "silent passthrough" this
    // capability's contract promises it never does. So an empty lowering DOORS here, at the
    // validation boundary, with the same binding-named message a bad bare-string type gets.
    if (Object.keys(json).length === 0) throw new Error("tag lowered to an empty (unconstrained) schema");
    return z.fromJSONSchema(json as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TypeTagError(bindingName, "unrecognized-tag", `${JSON.stringify(jsTag)} (${reason})`);
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
    "overridable/resolve":
      symbol.rosetta`overridable/resolve: resolves a parameter, preferring a host override over the form default (validated against the declared type)`(
        // `name` stays `sz.value` (the raw ASymbol), NOT `sz.symbol`: `sz.symbol` decodes to an
        // OPAQUE host JS `symbol` (`Symbol("arrival membrane symbol: <name>")` — see
        // scheme-zod.ts's own `symbol` primitive), and `nameSym.toString()` on that opaque
        // brand prints the whole wrapper description, not the bare name. This capability
        // genuinely needs the readable name (every error message names the binding), so it
        // reads the ASymbol directly via `.literal()` (the same "bare symbol name" accessor
        // the print protocol itself uses).
        { input: [sz.value, sz.value, sz.value], output: [sz.value], type: "(name: symbol, type: string|list, default: any): any" },
        function (this: CallCtx, nameSym, typeTag, defaultVal) {
          const bindingName = (nameSym as ASymbol).literal();
          const jsTag = schemeToJs(typeTag);
          const zodType = lowerTag(jsTag, bindingName);

          const hasOverride = Object.prototype.hasOwnProperty.call(configuration.params, bindingName);
          const raw = hasOverride ? configuration.params[bindingName] : schemeToJs(defaultVal);
          const source = hasOverride ? "an environment override" : "the in-form default";

          const outcome = zodType.safeParse(raw);
          if (!outcome.success) {
            throw new TypeTagError(bindingName, "value-mismatch", describeTag(jsTag), describeValue(raw), source);
          }
          return jsToScheme(CONSTANT_CTX, outcome.data);
        },
      ),
    "define/overridable":
      symbol.defineSyntax`define/overridable: like plain \`define\`, but the environment MAY override the value — a host-supplied param (via configuration.params) wins over the in-form default, and BOTH validate against the declared type — (define/overridable name type default)`(
        `(lambda (name type default)
           \`(define ,name (overridable/resolve ',name ,type ,default)))`,
        { macroAttribute: "binder" },
      ),
  }),
});
