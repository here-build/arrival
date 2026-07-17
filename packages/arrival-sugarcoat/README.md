# @inhuman.tools/arrival-sugarcoat

**Sugarcoat** is the reversible view of Scheme.

```
canonical: (map
              (lambda (it)
                (:family
                  (normalize
                     (car it))))
              evidence)
sugarcoat: evidence.map{ it[0].normalize[:family] }
```

One program, two faces. The stored form is always canonical s-expressions; Sugarcoat is a bidirectional lens over it — render for reading, fold edits back, intent preserved exactly.

## Who this is for

You have Scheme programs — stored, generated, or agent-written — and humans who need to read and edit them without breathing parentheses. Sugarcoat renders the stored s-expressions as syntax a JS/Python/Kotlin programmer parses at a glance, and folds their edits back losslessly. The human edits what they can read; the store keeps what the machine can prove.

The original driver is AI–human collaboration: the LLM writes canonical Scheme, the editor sweetens it for the person reviewing, their tweaks convert back for the agent to continue. Neither side ever holds a lossy translation of the other's work. Nothing requires the AI, though — it works fine as a plain readability lens.

## Quick start

```ts
import { schemeToSugarcoat, sugarcoatToScheme } from "@inhuman.tools/arrival-sugarcoat";

const scheme = "(map (lambda (it) (* it 2)) xs)";
schemeToSugarcoat(scheme);                        // → "xs.map{ it * 2 }"
sugarcoatToScheme("xs.map{ it * 2 }", scheme);    // → "(map (lambda (it) (* it 2)) xs)"
```

`@inhuman.tools/arrival-codemirror` wires this into an editor: you type Sugarcoat, the buffer stores Scheme, live.

**The full syntax — indentation, infix, subscripts, method chains, `it`, dicts, at-expressions — is a 5-minute read: [LEARN.md](./LEARN.md).**

## The guarantee

`ast(sugarcoatToScheme(schemeToSugarcoat(x), x)) ≡ ast(x)` — render then read gives back the original intent, always. Every transform is an isolated deterministic rule with an inverse, and the pair is verified by round-tripping a real program corpus byte-for-byte.

> **Why not byte-identity of the source?** Byte round-trip would preserve *spelling* — whether you wrote `caar` or `(car (car x))` — and spelling is exactly the noise a view should absorb. The lens quotients spelling and keeps intent: `(car (car x))` fuses to `caar`, formatting regenerates, and view-then-save never changes what a program means. What IS byte-stable is the stored file: saving an unedited view writes back the identical bytes.

> **Why isn't indentation stored?** Sugarcoat is indentation-structured (a line plus its deeper-indented children form one expression), but the canonical form carries zero layout semantics. The primary author of stored programs is a machine — it reads structure and gains nothing from layout, while inheriting every invisible-wrong-parse risk significant whitespace brings. So the store keeps visible delimiters; layout lives only in the human-facing view, regenerated on every render, impossible to corrupt.

## Two things in one package

1. **The lens** — `schemeToSugarcoat` / `sugarcoatToScheme`, everything above.
2. **The runtime-free reader** — `parseSexprs` / `printScheme`, a standalone s-expression parser with comment and span tracking.

The second is why half the toolchain depends on a "syntax skin": anything that must *parse* Scheme without *evaluating* it — the Mercury code generator, the type-lens LSP services, structural editing — imports the reader and never pulls the interpreter. Zero-dependency leaf either way (`tiny-invariant` is the only runtime dependency of the main entry).

## Going deeper

- [LEARN.md](./LEARN.md) — the whole syntax, learn-x-in-y-minutes style.
- [GRAMMAR.md](./GRAMMAR.md) — the formal grammar (layout → tokens → forms), precise enough to derive an editor mode; a ready TextMate grammar sits in [`editors/`](./editors/).
- `docs/package-specific/arrival-sugarcoat/` — design derivations: the positioning note, the grammar spec (with the formal round-trip law), the at-expressions spec, bound-name recovery.

## License

**[FSL-1.1-MIT](./LICENSE.md)** — Functional Source License 1.1, MIT Future License. Each version converts
to MIT two years after its release date. Until conversion, the license permits everything *except*
Competing Use (making the Software available in a commercial product or service that substitutes for the
Software or offers substantially similar functionality). Internal use, non-commercial education and
research, and professional services built on top of the Software are always permitted.

For licensing questions, exemptions, or clarifications: team@here.build.

If this package eventually becomes a commodity, we will be happy to convert it into MIT. FSL is chosen as an early-stage startup R&D defense against competitors and is not intended to be a permanent license for the whole package lifetime.
