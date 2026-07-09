// @here.build/arrival/schema — the `arrival/schema` capability: the s/* constructors
// (`s/object`, `s/array`, `s/enum`, `s/optional`, `s/field`, `s/field/<type>`). Prelude-only
// pure scheme, the srfi-pack shape (see `env/srfi/srfi-2.ts`) — no config, no resources, no
// native verbs, just `define`s any consumer applies as an ordinary capability or dependency.
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
// type syntax, full stop, and THIS capability (core, prelude-only, dependency-free) is its
// home. `arrival/overridable` depends on it for the runtime projection; the type-layer
// package reads the same s/* shape for the static one. Neither is more canonical than the
// other — they're two views of one proposition.
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
import { EnvCapability } from "../common/capability.js";

export const schemaCapability = new EnvCapability("arrival/schema", {
  prelude: `
;; ── schema DSL ─────────────────────────────────────────────────────
(define (s/object . fields)        (cons "object" fields))
(define (s/array element)          (list "array" element))
(define (s/enum . values)          (cons "enum" values))

;; (s/optional tag) — the \`/optional\` compositor: marks a tag's HEAD so the
;; object-field lowering (\`tagToJsonSchema\` in \`../common/schema-tag.js\`) drops that
;; field from \`required\` (zod: \`.optional()\`). Composes onto ANY tag, bare
;; ("string" → "string/optional") or list-headed (("enum" "A" "B") →
;; ("enum/optional" "A" "B")) — one explicit, bounded suffix, not a chain.
;; Only meaningful on an object field's tag; see \`s/field\` below for the
;; authoring shape: (s/field "bio" (s/optional "string")).
(define (s/optional tag)
  (if (pair? tag)
      (cons (string-append (car tag) "/optional") (cdr tag))
      (string-append tag "/optional")))

(define (s/field name type . desc)
  (if (null? desc) (list name type) (list name type (car desc))))

;; Top-level scalar constructors — the leaf primitives, spelled as s/* calls so a bare
;; "string"/"number"/"integer"/"boolean" literal never has to appear in authored code (a
;; \`define/overridable\` type tag, an array element, anywhere a tag stands alone rather than
;; inside an \`s/field\`). Each still lowers to the SAME bare string \`tagToJsonSchema\` has
;; always understood — this is authoring surface, not a new representation.
(define (s/string)  "string")
(define (s/number)  "number")
(define (s/integer) "integer")
(define (s/boolean) "boolean")

(define (s/field/string  name . rest) (apply s/field (cons name (cons "string"  rest))))
(define (s/field/number  name . rest) (apply s/field (cons name (cons "number"  rest))))
(define (s/field/integer name . rest) (apply s/field (cons name (cons "integer" rest))))
(define (s/field/boolean name . rest) (apply s/field (cons name (cons "boolean" rest))))

(define (s/field/_composite name . rest)
  (cond ((= (length rest) 1) (s/field name (car rest)))
        ((= (length rest) 2) (s/field name (cadr rest) (car rest)))
        (else (error "s/field/composite: expected (name config) or (name desc config)"))))

(define (s/field/object . args) (apply s/field/_composite args))
(define (s/field/array  . args) (apply s/field/_composite args))
(define (s/field/enum   . args) (apply s/field/_composite args))
`,
});
