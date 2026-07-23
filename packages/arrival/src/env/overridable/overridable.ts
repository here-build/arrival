// arrival/overridable — the `define/overridable` capability: plain `define` PLUS
// VALIDATION whose value the execution environment MAY override. Exposing that override
// surface (CLI argv, API caller props, runProgram params, a notebook's form fields, an
// agent's tool-call arguments) is the ENVIRONMENT'S job, never this capability's. It sees
// none of those contexts — only the merged `params` bag (`configuration.params`, validated
// structurally as z.record(z.string(), z.unknown()), supplied through
// `exec(src, { capabilities, config })`'s shared config bag, of which it validates only its
// own `params` slice).
//
// The one runtime verb is `overridable/resolve`, an ordinary rosetta; the macro is pure
// ergonomics over it:
//
//     (define/overridable city (s/string) "Berlin")
//       ⇒ (define city (overridable/resolve 'city (s/string) "Berlin"))
//
// `overridable/resolve` reads `configuration.params[name]` when the host supplied one (an
// OVERRIDE), else the in-form default; EITHER WAY it lowers `type` to a zod schema and
// `.parse()`s the value — so a bad DEFAULT throws exactly as loud as a bad OVERRIDE. It
// validates whoever supplied the value, the in-program author included. Calling it directly
// from user code is fine: it only ever reads the program's OWN params, nothing to leak.
//
// A `type` may be ANY s/* expression — `(s/enum "a" "b")`, a nested `(s/object …)`,
// `(s/optional …)` — lowered through the same canonical `tagToJsonSchema` + `z.fromJSONSchema`
// every schema consumer uses, so it cannot drift from the wire schema (see arrival/schema, the
// declared `deps` that binds the s/* constructors here).
//
// NOT in BASE_PACKS: config-bearing (params differ per run) and lowered per-consumer, so an
// overridable pack is assembled FRESH per run with that run's host-supplied parameter values —
// unlike core/polyglot/srfi, assembled once into every env.

import { z } from "zod";

import { TypeTagError } from "../../errors.js";
import { EnvCapability } from "../../common/capability.js";
import { jsToScheme, schemeToJs } from "../../membrane/rosetta.js";
import { stripOptionalSuffix, tagToJsonSchema } from "../../common/schema-tag.js";
import { CONSTANT_CTX } from "../../run/RunContext.js";
import { ASymbol } from "../../values/primitives/ASymbol.js";
import { schemaCapability } from "../schema/schema.js";

/** Lower a `define/overridable` type tag (an evaluated scheme value, already `schemeToJs`'d
 *  into canonical JS tagged-list form) to the zod schema that validates a JS value against it.
 *  Routes through the ONE canonical lowering — `tagToJsonSchema` + `z.fromJSONSchema`, the same
 *  bridge the wire schema and HTTP validator use — so every tag the s/* DSL expresses is accepted,
 *  and a tag that can't become a real validator DOORS with the binding name, not silently. */
function lowerTag(jsTag: unknown, bindingName: string): z.ZodType {
  try {
    const json = tagToJsonSchema(jsTag);
    // `tagToJsonSchema` is deliberately LENIENT: an unrecognized shape falls through to `{}`
    // rather than throwing — correct for the wire-schema/HTTP projections, but `{}` lowers to a
    // permissive validator that would silently accept ANY override. So an empty lowering DOORS here.
    if (Object.keys(json).length === 0) throw new Error("tag lowered to an empty (unconstrained) schema");
    return z.fromJSONSchema(json as Parameters<typeof z.fromJSONSchema>[0]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TypeTagError(bindingName, "unrecognized-tag", `${JSON.stringify(jsTag)} (${reason})`);
  }
}

/** A short human phrase for a (lowered) type tag, for the error's "expected …" clause: the
 *  `/optional`-stripped bare string, an enum's value list, else a plain JSON-stringify. */
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

export const overridableCapability = EnvCapability.define("arrival/overridable", {
  // config-less lower MUST succeed: a consumer assembling without params still gets the
  // capability, and every in-form default then fires, validated as an override would be.
  configuration: { params: z.record(z.string(), z.unknown()).default({}) },
  // s/* must be BOUND wherever overridable/resolve runs: define/overridable splices `type`
  // unquoted, so `(s/enum "a" "b")` is CALLED in the same env before the rosetta sees it.
  // Declaring the dep binds it wherever this capability is applied, root-set or not.
  deps: [schemaCapability],
  symbols: (symbol, sz) => ({
    "overridable/resolve":
      symbol.rosetta`overridable/resolve: resolves a parameter, preferring a host override over the form default (validated against the declared type)`(
        // `name` stays `sz.value` (the raw ASymbol), NOT `sz.symbol`: sz.symbol decodes to an
        // opaque host JS symbol whose toString prints the wrapper description, not the bare
        // name. Errors name the binding, so read the ASymbol directly via `.literal()`.
        {
          input: [sz.value, sz.value, sz.value],
          output: [sz.value],
          type: "(name: symbol, type: string|list, default: any): any",
        },
        function (nameSym, typeTag, defaultVal) {
          const bindingName = (nameSym as ASymbol).literal();
          const jsTag = schemeToJs(typeTag);
          const zodType = lowerTag(jsTag, bindingName);

          const hasOverride = Object.prototype.hasOwnProperty.call(this.configuration.params, bindingName);
          const raw = hasOverride ? this.configuration.params[bindingName] : schemeToJs(defaultVal);
          const source = hasOverride ? "an environment override" : "the in-form default";

          const outcome = zodType.safeParse(raw);
          if (!outcome.success) {
            throw new TypeTagError(bindingName, "value-mismatch", describeTag(jsTag), describeValue(raw), source);
          }
          return jsToScheme(CONSTANT_CTX, outcome.data);
        },
      ),
    // macroAttribute "binder", not "expression"/"opaque": `name` is a FORMALS position spliced
    // only into `(define ,name …)`, never read as a value — walking it as expression space would
    // flag the binding target `unbound-symbol` on every legal program. Unlike cut/cute's "opaque"
    // placeholders (consumed positionally, never in output), `name` genuinely BINDS. type/default
    // ARE expression space, but with no per-argument binding-aware walker yet the whole call is
    // firewalled like "opaque"; "binder" is the honest classification for when that walker lands.
    "define/overridable":
      symbol.defineSyntax`define/overridable: like plain \`define\`, but the environment MAY override the value — a host-supplied param (via configuration.params) wins over the in-form default, and BOTH validate against the declared type — (define/overridable name type default)`(
        `(lambda (name type default)
           \`(define ,name (overridable/resolve ',name ,type ,default)))`,
        { macroAttribute: "binder" },
      ),
  }),
});
