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
// zod schema — the scalar subset `"string"` / `"number"` / `"boolean"` / an `("enum" v...)` list,
// an inert `/optional` suffix tolerated on the head — and `.parse()`s the arriving value. So a
// bad DEFAULT throws exactly as loud as a bad OVERRIDE: this is "plain define plus validation" —
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
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";

const OPTIONAL_SUFFIX = "/optional";

/** A tag's HEAD + (for a list-headed tag, e.g. `("enum" ...)`) its rest, with the `/optional`
 *  suffix stripped off the head. The suffix is TOLERATED, not meaningful here — there is always
 *  an in-form default to fall back to, so "optional" carries no requiredness distinction at this
 *  layer (unlike the object-field position it means something at in the wire-schema DSL). `undefined`
 *  ⇒ the tag isn't shaped like a scalar tag at all (neither a bare string nor a list headed by a
 *  string). */
function tagHead(tag: unknown): { head: string; rest?: readonly unknown[] } | undefined {
  if (typeof tag === "string") {
    return { head: tag.endsWith(OPTIONAL_SUFFIX) ? tag.slice(0, -OPTIONAL_SUFFIX.length) : tag };
  }
  if (Array.isArray(tag) && tag.length > 0 && typeof tag[0] === "string") {
    const head = tag[0].endsWith(OPTIONAL_SUFFIX) ? tag[0].slice(0, -OPTIONAL_SUFFIX.length) : tag[0];
    return { head, rest: tag.slice(1) };
  }
  return undefined;
}

/** Lower a `define/overridable` type tag to the zod schema that validates a JS value against it.
 *  The scalar subset: `"string"` / `"number"` / `"boolean"` (bare tags) and `("enum" v...)` (a
 *  scheme LIST whose head is `"enum"` — write it as `'("enum" "a" "b")` in source; the quote
 *  evaluates to the list, which `schemeToJs` turns into a JS array before it reaches here). A tag
 *  this capability doesn't recognize DOORS with the binding name in the message — never a silent
 *  passthrough. */
function lowerTag(jsTag: unknown, bindingName: string): z.ZodType {
  const parsed = tagHead(jsTag);
  if (!parsed) {
    throw new Error(
      `define/overridable ${bindingName}: unrecognized type tag ${JSON.stringify(jsTag)} — expected ` +
        `"string", "number", "boolean", or an ("enum" value...) list (an "/optional" suffix on the ` +
        `head is tolerated but inert here — the in-form default already supplies the fallback)`,
    );
  }
  switch (parsed.head) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
    case "enum": {
      const values = (parsed.rest ?? []).map(String);
      if (values.length === 0) {
        throw new Error(`define/overridable ${bindingName}: an "enum" type tag needs at least one value`);
      }
      return z.enum(values as [string, ...string[]]);
    }
    default:
      throw new Error(
        `define/overridable ${bindingName}: unrecognized type tag head "${parsed.head}" — expected ` +
          `"string", "number", "boolean", or "enum"`,
      );
  }
}

/** A short human phrase for a (lowered) type tag, for the error message's "expected …" clause. */
function describeTag(jsTag: unknown): string {
  const parsed = tagHead(jsTag);
  if (!parsed) return JSON.stringify(jsTag);
  return parsed.head === "enum" ? `one of ${JSON.stringify((parsed.rest ?? []).map(String))}` : parsed.head;
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
    ;; TEMP alias — removed by the rename sweep (downstream still authors the old name).
    (define-macro (define/pipeline-input name type default)
      \`(define ,name (overridable/resolve ',name ,type ,default)))
  `,
});

/** TEMP alias for the rename sweep — downstream rosters still import this name. Removed with it. */
export const pipelineInputCapability = overridableCapability;
