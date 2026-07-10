// @here.build/arrival/schema — the `arrival/schema` capability: the s/* constructors
// (`s/object`, `s/array`, `s/enum`, `s/optional`, `s/field`, `s/field/<type>`). No config, no
// resources, no native verbs — every symbol below is a `symbol.define`, the scheme-bodied
// declaration kind (docs/working-proposals/symbol-define-static-program-validation.md §1),
// applied as an ordinary capability or dependency.
//
// ── s/* is the only place where types appear explicitly ──────────────────────────────────
//
// "s/* is the only place where types appear explicitly." No parallel tag subsets, no
// hand-rolled lowerings — one type language, one lowering. A hand-rolled scalar subset
// per-consumer (as `arrival/overridable` once carried) can silently drift from what the wire
// schema and the HTTP validator actually accept — so every `define/overridable` type tag goes
// through the SAME s/* vocabulary a hosted function's `(s/object …)` signature uses, lowered by
// the SAME `tagToJsonSchema` recursion (`../common/schema-tag.js`) every other consumer lowers
// through.
//
// ── why this lives in CORE, not "a schema DSL for endpoints" ──────────────────────────────
//
// Arrival is adopting a borrowed Curry-Howard type system: core integrates the type-level
// wiring all the way down to tsc, which requires NATIVE-level type narrowing — a type-layer
// bridge (the `signatureOf` spine, tsgo narrowing) that only works if the type vocabulary is
// a first-class part of the language's own core, not an appendage bolted on by one consumer
// (inference, or an HTTP endpoint layer). s/* expressions ARE the propositions of that type
// system. The same s/* type discharges in TWO projections:
//
//   • statically  — the tsc/type-layer bridge, `signatureOf` spine, tsgo narrowing (a
//     program's declared input/output tag becomes a checked TypeScript shape); and
//   • at runtime  — the zod lowering (`tagToJsonSchema` → `z.fromJSONSchema`), the
//     operational shadow of the exact same type.
//
// The zod door is one projection of the type, not the definition of it. So s/* is not "a
// schema DSL for endpoints" that inference happens to reuse — it is the language's explicit
// type syntax, full stop, and THIS capability (core, dependency-declared not dependency-free —
// see the MIGRATION NOTE below) is its home. `arrival/overridable` depends on it for the
// runtime projection; the type-layer package reads the same s/* shape for the static one.
// Neither is more canonical than the other — they're two views of one proposition.
//
// ── provenance ─────────────────────────────────────────────────────────────────────────────
//
// Moved verbatim from `@here.build/arrival-run`'s `run-program.ts` `BUILTIN_PREAMBLE`
// (2026-07-03) — that file's preamble now carries a pointer comment here instead of the
// definitions themselves. NOT in `BASE_PACKS` (it's not scheme stdlib — it's config-free but
// domain-specific, the same posture `arrival/overridable` has); consumed as an ordinary
// capability (listed in `arrivalCapabilities()`'s root set) AND declared as
// `arrival/overridable`'s dependency, so `(s/enum …)` used as a `define/overridable` type tag
// resolves wherever that capability is applied — root-set membership or not.
//
// MIGRATION NOTE (W4-H2b, docs/working-proposals/symbol-define-static-program-validation.md
// §1/§2/§4): the former `prelude` text blob (13 `define`s, zero macros — this pack sits on the
// pure-`symbol.define` side of the census, unlike its `arrival/overridable` sibling which
// carried the ONE macro) decomposes 1:1 below, one `symbol.define` per value/procedure define,
// declaration order preserved (§2.3).
//
// THE WIRE FORMAT IS UNCHANGED — this is the load-bearing invariant this migration must hold:
// `mercury`'s `type-infer.ts` (`tagToZod`) and every s/* consumer (`common/schema-tag.js`'s
// `tagToJsonSchema`, `arrival/overridable`'s `lowerTag`) read the TAGGED-LIST SHAPE these
// constructors produce — a bare string, or a proper list `("object" (name type [desc])…)` /
// `("array" element)` / `("enum" value…)`. Contract enforcement (§1.2) is validate-ONLY: bake's
// `z.decode(def.out, …)` runs purely for its throw-on-mismatch side effect and the decoded value
// is DISCARDED (`define-bake.ts`'s own comment) — the original scheme value returned by each
// body is handed back UNCHANGED. So as long as no schema below REJECTS a value these bodies
// actually produce, the wire format cannot drift by construction; every schema chosen here was
// checked against that bar, not just against "does it look like a reasonable type."
//
// THE DEPS EDGE IS NEW, AND IT IS A REAL FIX, NOT DECORATION (§2.1's bake FV law, the srfi-235
// "luck becomes structure" precedent, W4-H1): the prelude-era bodies below call `cons`/`list`
// (scheme/lists), `pair?`/`null?` (scheme/equality), `string-append` (scheme/strings), `=`
// (scheme/numeric), and `error` (scheme/r7rs/exceptions) — none of them declared anywhere.
// It worked only because every consumer (`arrival/overridable`'s dep chain, `exec()`'s default
// base assembly, arrival-mcp/arrival-chain's root sets) happens to also assemble the R7RS base
// packs in the same env — assembly-order luck, exactly the class of bug §2.1 exists to convert
// into a declared, bake-checked edge. `car`/`cdr` need NO edge — the resolver-synth `c[ad]+r`
// family (§2.3's bake allowlist) resolves them directly, unconditionally.
//
// Contract choices (§1.2's "REAL contract authored per define, day one" — mirrors srfi-128.ts's
// own contract-choices note):
//   - a `tag` (the `s/optional`/`s/array`-element domain) is modeled as `z.union([z.string,
//     z.cons(z.string, z.value)])` — ONE level of real structure, not opaque `z.value`: it is
//     exactly the shape `s/optional`'s own body branches on (`pair?`, then `(car tag)` fed to
//     `string-append`, which demands a string head) — a non-string, non-string-headed-pair tag
//     would already crash inside the body today, just with an uglier low-level error; the
//     contract just moves that failure to the call boundary with a legible message (§4.2: "a
//     wrong-arity call... now fails at the contract boundary, with a better message" — the SAME
//     posture, one level deeper). The cdr/tail stays `z.value` — genuinely unconstrained: a
//     tag's inner shape is arbitrarily recursive (an object field's type is itself a tag), and
//     no consumer here inspects past the one level `pair?`/`car` actually reads.
//   - `s/field`'s `type` param and `s/field/_composite`'s `rest` stay honest `z.value` — neither
//     is inspected by ITS OWN body (both just embed or forward the value opaquely); tightening
//     either to `tag` would assert a constraint this pack's own code never checks and (per the
//     §4.1 census note that "some polyglot aliases ARE genuinely shapeless") is exactly the
//     legitimate use of that carve-out, not a shortcut.
//   - the `s/field`-shape output (`(name type)` / `(name type desc)`) is `z.list([z.string,
//     z.value], z.string)` — TWO fixed heads (name, type) then a homogeneous string tail. This
//     slightly OVER-approximates (it would tolerate more than one trailing desc element, which
//     no body here ever produces) rather than under — the safe direction for a migration whose
//     hard requirement is "never reject a value the pre-migration body actually returned."
//   - `s/object`/`s/enum` share the SAME output shape for the SAME reason: `(cons "object"
//     fields)` / `(cons "enum" values)` is always a proper list (a dotted-rest formal captures
//     a nil-terminated list, `cons`-ing a string onto it just prepends) — `z.list([z.string],
//     z.value)` (one string head, zero-or-more `z.value` tail) is the honest structural read,
//     not a looser `z.value` fallback.
//   - `s/string`/`s/number`/`s/integer`/`s/boolean` are real 0-ary thunks returning a fixed
//     string literal — `{ input: [], output: [z.string] }`, no `z.custom`, no shapeless escape.
//   - `s/field`/`s/field/<type>` keep their REST desc arg as `inputRest: z.string` (not a fixed
//     tuple with one trailing `.optional()`) precisely to preserve the pre-migration body's own
//     tolerance for being CALLED with more than one trailing element (silently ignored beyond
//     the first, `(car desc)`) — a fixed-arity contract would make that call throw where the
//     body never did. Real type (every trailing element genuinely is a description string),
//     unchanged permissiveness.
import { EnvCapability } from "../common/capability.js";
import { symbol } from "../common/symbol.js";
import * as z from "../common/scheme-zod.js";
import lists from "./r7rs/lists.js";
import equality from "./r7rs/equality.js";
import strings from "./r7rs/strings.js";
import numeric from "./r7rs/numeric.js";
import exceptions from "./r7rs/exceptions.js";

// A schema-DSL type tag — see the contract-choices note above. Shared by `s/optional`'s
// `tag` param/return and `s/array`'s `element` param (both are genuine tag positions;
// `s/field`'s `type` and `s/field/_composite`'s `rest` are NOT — see the note for why).
const tag = z.union([z.string, z.cons(z.string, z.value)]);

// The `s/field`-shape output every `s/field*` constructor returns — see the contract-choices
// note above for why this is a real (slightly over-approximating) structural contract, not
// `z.value`.
const fieldShape = z.list([z.string, z.value], z.string);

export const schemaCapability = new EnvCapability("arrival/schema", {
  // See the MIGRATION NOTE above — every one of these was an undeclared, assembly-order-luck
  // reference before this migration; the FV bake law (§2.1) now checks each one for real.
  deps: [lists, equality, strings, numeric, exceptions],
  symbols: {
    "s/object": symbol.define`s/object: an object type tag from field-tag entries — (s/object (s/field name type)...)`(
      { input: z.array(z.value), output: [z.list([z.string], z.value)] },
      `(lambda fields (cons "object" fields))`,
    ),

    "s/array": symbol.define`s/array: an array type tag whose elements are all shaped by element — (s/array tag)`(
      { input: [tag], output: [z.list([z.string, z.value])] },
      `(lambda (element) (list "array" element))`,
    ),

    "s/enum": symbol.define`s/enum: an enum type tag over the given literal values — (s/enum value...)`(
      { input: z.array(z.value), output: [z.list([z.string], z.value)] },
      `(lambda values (cons "enum" values))`,
    ),

    // (s/optional tag) — the `/optional` compositor: marks a tag's HEAD so the object-field
    // lowering (`tagToJsonSchema` in `../common/schema-tag.js`) drops that field from
    // `required` (zod: `.optional()`). Composes onto ANY tag, bare ("string" →
    // "string/optional") or list-headed (("enum" "A" "B") → ("enum/optional" "A" "B")) — one
    // explicit, bounded suffix, not a chain. Only meaningful on an object field's tag; see
    // `s/field` below for the authoring shape: (s/field "bio" (s/optional "string")).
    "s/optional": symbol.define`s/optional: mark a tag's head /optional — meaningful only on an object field's tag`(
      { input: [tag], output: [tag] },
      `(lambda (tag)
         (if (pair? tag)
             (cons (string-append (car tag) "/optional") (cdr tag))
             (string-append tag "/optional")))`,
    ),

    "s/field": symbol.define`s/field: (name type [description]) — an object field entry for s/object`(
      { input: [z.string, z.value], inputRest: z.string, output: [fieldShape] },
      `(lambda (name type . desc)
         (if (null? desc) (list name type) (list name type (car desc))))`,
    ),

    // Top-level scalar constructors — the leaf primitives, spelled as s/* calls so a bare
    // "string"/"number"/"integer"/"boolean" literal never has to appear in authored code (a
    // `define/overridable` type tag, an array element, anywhere a tag stands alone rather than
    // inside an `s/field`). Each still lowers to the SAME bare string `tagToJsonSchema` has
    // always understood — this is authoring surface, not a new representation.
    "s/string": symbol.define`s/string: the "string" scalar type tag`({ input: [], output: [z.string] }, `(lambda () "string")`),
    "s/number": symbol.define`s/number: the "number" scalar type tag`({ input: [], output: [z.string] }, `(lambda () "number")`),
    "s/integer": symbol.define`s/integer: the "integer" scalar type tag`(
      { input: [], output: [z.string] },
      `(lambda () "integer")`,
    ),
    "s/boolean": symbol.define`s/boolean: the "boolean" scalar type tag`(
      { input: [], output: [z.string] },
      `(lambda () "boolean")`,
    ),

    "s/field/string": symbol.define`s/field/string: (s/field name "string" [description...]) shortcut`(
      { input: [z.string], inputRest: z.string, output: [fieldShape] },
      `(lambda (name . rest) (apply s/field (cons name (cons "string" rest))))`,
    ),
    "s/field/number": symbol.define`s/field/number: (s/field name "number" [description...]) shortcut`(
      { input: [z.string], inputRest: z.string, output: [fieldShape] },
      `(lambda (name . rest) (apply s/field (cons name (cons "number" rest))))`,
    ),
    "s/field/integer": symbol.define`s/field/integer: (s/field name "integer" [description...]) shortcut`(
      { input: [z.string], inputRest: z.string, output: [fieldShape] },
      `(lambda (name . rest) (apply s/field (cons name (cons "integer" rest))))`,
    ),
    "s/field/boolean": symbol.define`s/field/boolean: (s/field name "boolean" [description...]) shortcut`(
      { input: [z.string], inputRest: z.string, output: [fieldShape] },
      `(lambda (name . rest) (apply s/field (cons name (cons "boolean" rest))))`,
    ),

    "s/field/_composite": symbol.define`s/field/_composite: (name config) or (name desc config) — shared dispatcher for the composite s/field/<type> shortcuts`(
      { input: [z.string], inputRest: z.value, output: [fieldShape] },
      `(lambda (name . rest)
         (cond ((= (length rest) 1) (s/field name (car rest)))
               ((= (length rest) 2) (s/field name (cadr rest) (car rest)))
               (else (error "s/field/composite: expected (name config) or (name desc config)"))))`,
    ),

    "s/field/object": symbol.define`s/field/object: (s/field name (s/object ...)) / (s/field name description (s/object ...)) shortcut`(
      { input: z.array(z.value), output: [fieldShape] },
      `(lambda args (apply s/field/_composite args))`,
    ),
    "s/field/array": symbol.define`s/field/array: (s/field name (s/array ...)) / (s/field name description (s/array ...)) shortcut`(
      { input: z.array(z.value), output: [fieldShape] },
      `(lambda args (apply s/field/_composite args))`,
    ),
    "s/field/enum": symbol.define`s/field/enum: (s/field name (s/enum ...)) / (s/field name description (s/enum ...)) shortcut`(
      { input: z.array(z.value), output: [fieldShape] },
      `(lambda args (apply s/field/_composite args))`,
    ),
  },
});
