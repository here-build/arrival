// arrival/schema — the s/* type constructors: s/object, s/array, s/enum, s/optional,
// s/field, s/field/<type>. No config, no resources, no native verbs — every symbol is a
// `symbol.define` (scheme-bodied), applied as an ordinary capability or dependency.
//
// s/* is the one place types appear explicitly: one type language, one lowering. A
// per-consumer hand-rolled scalar subset (as arrival/overridable once carried) silently
// drifts from what the wire schema and HTTP validator accept — so every define/overridable
// type tag goes through the SAME s/* vocabulary a hosted function's (s/object …) signature
// uses, lowered by the SAME tagToJsonSchema recursion (common/schema-tag.js) every consumer
// lowers through.
//
// This lives in CORE, not "a schema DSL for endpoints": s/* expressions ARE the propositions
// of arrival's borrowed Curry-Howard type system, discharging in two projections — statically
// (the tsc/type-layer bridge, signatureOf spine, tsgo narrowing) and at runtime (the zod
// lowering). The zod door is one projection, not the definition. So arrival/overridable deps on
// it for the runtime projection, the type-layer package reads the same shape for the static one.
//
// Config-free but domain-specific (the same posture as arrival/overridable), it lives OUTSIDE
// BASE_PACKS (not scheme stdlib): consumed as an ordinary capability (in arrivalCapabilities()'s
// root set) AND declared as arrival/overridable's dependency, so (s/enum …) used as a type tag
// resolves wherever that capability is applied, root-set membership or not.
//
// WIRE FORMAT — the load-bearing invariant every constructor holds: mercury's type-infer.ts
// (tagToZod) and every s/* consumer read the TAGGED-LIST SHAPE these bodies produce — a bare
// string, or a proper list ("object" (name type [desc])…) / ("array" element) / ("enum"
// value…). Contract enforcement is validate-ONLY: bake's z.decode(def.out, …) runs purely for
// its throw-on-mismatch side effect and DISCARDS the decoded value; each body's original scheme
// value is handed back UNCHANGED. So as long as no schema below REJECTS a value a body produces,
// the wire format cannot drift by construction — which sets the contract-choices rule below:
// model the real structure each body reads/produces, over-approximate rather than under, and
// leave positions a body forwards opaquely as z.schemeValue.
//
// DEPS: cons/list (scheme/lists), pair?/null? (scheme/equality), string-append (scheme/strings),
// = (scheme/numeric), error (scheme/r7rs/exceptions) are every cross-capability free name the
// bodies reach — each a declared deps edge. car/cdr need no edge — the resolver-synth c[ad]+r
// family resolves them unconditionally.
import { EnvCapability } from "../../common/capability.js";
import lists from "../r7rs/lists.js";
import equality from "../r7rs/equality.js";
import strings from "../r7rs/strings.js";
import numeric from "../r7rs/numeric.js";
import exceptions from "../r7rs/exceptions.js";

// A schema-DSL type tag: z.union([z.string, z.cons(z.string, z.schemeValue)]) — one level of real
// structure, exactly what s/optional's body branches on (pair?, then (car tag) fed to
// string-append, which demands a string head). The cdr stays z.schemeValue: a tag's inner shape is
// arbitrarily recursive and no body here reads past that one level. Shared by s/optional and
// s/array's element; s/field's `type` and s/field/_composite's `rest` forward opaquely, so they
// stay z.schemeValue, not tag.
// DEPS ORDER (Stage C Cut 2): `equality, numeric, exceptions, strings, lists` — matching the
// partial order every BASE_PACKS member reaching these same nodes already agrees on (`equality`
// before `numeric` before `scheme/r7rs/exceptions` before `strings` before `lists` last — the
// chain `scheme/polyglot-racket`'s own dep-closure establishes over `scheme/polyglot-clojure`'s:
// racket declares `exceptions` ahead of `vectors`/`lists`, clojure — reached transitively through
// racket's `deps: [polyglotClojure, …]` — places `strings` between `numeric` and `vectors`, so
// the ALREADY-WORKING merge fixes `exceptions` before `strings`). This capability's own SET of
// deps is unchanged; only the array's ORDER moved, because Cut 2's self-hosted vocabulary tuple
// now C3-linearizes THIS capability together with the base roster in ONE closure walk
// (`env/base-roster.ts`) — under the legacy ambient path this capability's deps were linearized
// in ISOLATION (a separate `assembleEnv` call from the base bootstrap), so no other pack's
// opinion about relative precedence among these shared nodes was ever in the same merge to
// conflict with.
export const schemaCapability = EnvCapability.define("arrival/schema", {
  deps: [equality, numeric, exceptions, strings, lists],
  symbols: (symbol, z) => {
    const tag = z.union([z.string, z.cons(z.string, z.schemeValue)]);
    // The s/field-shape output every s/field* body returns: two fixed heads (name, type) then a
    // string tail. Over-approximates (tolerates >1 trailing desc, none produced) rather than under —
    // never rejecting a value a body returns.
    const fieldShape = z.list([z.string, z.schemeValue], z.string);
    return {
      "s/object":
        symbol.define`s/object: an object type tag from field-tag entries — (s/object (s/field name type)...)`(
          { input: z.array(z.schemeValue), output: [z.list([z.string], z.schemeValue)] },
          `(lambda fields (cons "object" fields))`,
        ),

      "s/array": symbol.define`s/array: an array type tag whose elements are all shaped by element — (s/array tag)`(
        { input: [tag], output: [z.list([z.string, z.schemeValue])] },
        `(lambda (element) (list "array" element))`,
      ),

      "s/enum": symbol.define`s/enum: an enum type tag over the given literal values — (s/enum value...)`(
        { input: z.array(z.schemeValue), output: [z.list([z.string], z.schemeValue)] },
        `(lambda values (cons "enum" values))`,
      ),

      // The `/optional` compositor: marks a tag's HEAD so the object-field lowering
      // (tagToJsonSchema) drops that field from `required`. Composes onto ANY tag, bare ("string"
      // → "string/optional") or list-headed (("enum" …) → ("enum/optional" …)) — one bounded
      // suffix, not a chain. Meaningful only on an object field's tag.
      "s/optional": symbol.define`s/optional: mark a tag's head /optional — meaningful only on an object field's tag`(
        { input: [tag], output: [tag] },
        `(lambda (tag)
         (if (pair? tag)
             (cons (string-append (car tag) "/optional") (cdr tag))
             (string-append tag "/optional")))`,
      ),

      "s/field": symbol.define`s/field: (name type [description]) — an object field entry for s/object`(
        { input: [z.string, z.schemeValue], inputRest: z.string, output: [fieldShape] },
        `(lambda (name type . desc)
         (if (null? desc) (list name type) (list name type (car desc))))`,
      ),

      // Top-level scalar constructors — leaf primitives spelled as s/* calls so a bare
      // "string"/"number"/"integer"/"boolean" literal never has to appear in authored code. Each
      // lowers to the SAME bare string tagToJsonSchema understands — authoring surface, not a new representation.
      "s/string": symbol.define`s/string: the "string" scalar type tag`(
        { input: [], output: [z.string] },
        `(lambda () "string")`,
      ),
      "s/number": symbol.define`s/number: the "number" scalar type tag`(
        { input: [], output: [z.string] },
        `(lambda () "number")`,
      ),
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

      "s/field/_composite":
        symbol.define`s/field/_composite: (name config) or (name desc config) — shared dispatcher for the composite s/field/<type> shortcuts`(
          { input: [z.string], inputRest: z.schemeValue, output: [fieldShape] },
          `(lambda (name . rest)
         (cond ((= (length rest) 1) (s/field name (car rest)))
               ((= (length rest) 2) (s/field name (cadr rest) (car rest)))
               (else (error "s/field/composite: expected (name config) or (name desc config)"))))`,
        ),

      "s/field/object":
        symbol.define`s/field/object: (s/field name (s/object ...)) / (s/field name description (s/object ...)) shortcut`(
          { input: z.array(z.schemeValue), output: [fieldShape] },
          `(lambda args (apply s/field/_composite args))`,
        ),
      "s/field/array":
        symbol.define`s/field/array: (s/field name (s/array ...)) / (s/field name description (s/array ...)) shortcut`(
          { input: z.array(z.schemeValue), output: [fieldShape] },
          `(lambda args (apply s/field/_composite args))`,
        ),
      "s/field/enum":
        symbol.define`s/field/enum: (s/field name (s/enum ...)) / (s/field name description (s/enum ...)) shortcut`(
          { input: z.array(z.schemeValue), output: [fieldShape] },
          `(lambda args (apply s/field/_composite args))`,
        ),
    };
  },
});
