# Attestation: branded `s/*` values and the uniform tool-boundary check

The `s/*` validator family produces *attested* values, and every manifold-bound tool argument
is *attestation-requiring* — uniformly, no per-function declarations. A model cannot pass a
bare model-authored value into a tool; it must wrap it: `(s/number 37)` / `(s/string "Berlin")`.
This is an explicit decision about *what the value is*, not a type hint. Tool return values are
machine-attested automatically, so nested composition `(outer :x (inner …))` stays free;
plucked fields inherit; computed values deliberately lose attestation and must be re-attested.

The mechanism spans two packages: the core registry + stamp sites live in arrival
(`values/attestation.ts`); enforcement, the `s/*` family, and the config knob live in the
manifold (`bind.ts`, `config.ts`). This doc holds the cross-package design; the stamp-site
mechanics and the frozen error construction live in those modules' headers. Behavioral cases
live in the test suites (`arrival/src/__tests__/attestation.test.ts` for the core return-walk;
`arrival-manifold/src/__tests__/attestation-flows.test.ts` for the flow cases below).

## 1. Why a WeakSet registry, not the provenance channel

This is **provenance/taint-flow, not typing** — but it needs a *different carrier* from the
provenance set arrival already tracks. Provenance *forwards* through computation (`(+ (:a r) 1)`
still carries `r`'s provenance — indistinguishable from a pluck at the provenance level);
attestation must *drop* on computation, so a model has to re-assert what a computed value IS.
Different algebra, different channel.

**Rejected: a pure manifold-side `WeakSet` sidecar (zero core change).** It carries `s/*`
stamps fine, but pluck-inheritance is unreachable — plucked boxes are minted inside core
membrane internals the manifold cannot see or register into. So the registry must live in core.

**Rejected: riding the provenance set.** Wrong algebra (above). **Rejected: a new constructor
field on the value type** — value clones serve both the compute path (must drop) and the
deep-stamp path (must set), so a field would need per-call-site clone semantics; an
identity-keyed `WeakSet` expresses "drop unless explicitly carried" natively.

**Chosen:** a `WeakSet<AValue>` in `values/attestation.ts`. It works because every scalar and
container value is a distinct box per occurrence — no small-number or string interning in the
value layer — so a WeakSet carries per-value attestation without aliasing. The exception is a
small set of shared singletons (`#t`/`#f`, `nil`, void, interned symbols): `attest()` refuses
them by identity, and validators fresh-clone before attesting (truthiness in the evaluator is
structural, never a reference check, so cloning a boolean is safe). `nil` and void are
permanently exempt — an absent field or a void result is never "attested."

Reference semantics make the registry self-propagating for free: `let`, argument passing, and
list/vector storage bind and return the same box, so `car`/`vector-ref`/`let`-bound variables
stay attested with no bookkeeping. Computation mints a fresh box for its result, so
drop-on-compute falls out of existing behavior — only the *provenance* channel needed new
forwarding logic, not attestation.

**Three stamp sites, each mirroring an existing provenance touch:** (1) the tool-return walk
deep-attests a source rosetta's spine + leaves in the same pass as the provenance deep-stamp;
(2) object-property / array-element access attests iff the container is attested (inheritance
is literal); (3) each `s/*` validator attests its argument on pass. Enforcement stays wholly in
the manifold tool boundary; core arrival symbols (`+`, `string-append`, `map`…) are
computation, not tools, and never check.

## 2. Flow algebra

| Expression shape | Carrier event | Verdict at tool boundary |
|---|---|---|
| literal `37`, `"x"`, `#t`, `'(1 2)`, `{...}` | reader/eval-minted box, never attested | **rejected** |
| `(s/number 37)` | validator attests (identity return) | passes |
| `(inner …)` nested in an outer call | return walk attests every node (site 1) | passes |
| `(:k r)` / `(@ r :k)` / `(@ r "k")` | object-property access inherits (site 2) | passes iff `r` attested |
| `(car r)` / `(vector-ref r i)` / `(list-ref r i)` | stored box, attested by return walk | passes iff produced by a tool |
| `(let ((x A)) … x)`, lambda args | reference passing | preserves A's verdict |
| `(if c A B)`, `(and …)`, `(or …)` | select — returns an operand's box | preserves the selected operand's verdict |
| `(+ (:a r) 1)`, `(string-append …)`, any compute | fresh box, not attested | **rejected** — model re-attests |
| `(s/number (+ (:a r) 1))` | re-attestation (deliberate laundering) | passes |
| `(map f r)` and other HOF products | fresh containers per element op | **rejected** unless re-attested (a transform is a computation) |
| missing key → `nil`; `#void` | exempt singletons | rejected (and `s/*` reject them too) |

`s/object` / `s/array` have **shallow semantics** — the wrapper attests the container box only;
element attestation is whatever each element carries. Pluck inheritance then makes fields
plucked from an attested container attested, which composes correctly: one `(s/object {…})`
makes the dict passable as a whole AND its plucked fields passable. A dict mixing tool-derived
and model-authored fields is a container the model *built* — computing — so requiring one
explicit `s/object` on it is the intended friction.

## 3. Config knob

`attestation: "off" | "available" | "required"`, threaded like other manifold config fields
(schema → `ManifoldConfig` → env/tool construction). Default **`"available"`**.

- `"off"` — `s/*` bind as plain validators; no stamping, no checks.
- `"available"` — full stamping live; the boundary check runs but only *counts* (a per-call
  `unattested: […]` note) — the measurement mode for model-compliance friction before flipping
  the default.
- `"required"` — the boundary rejects unattested args with the frozen error below.

## 4. Frozen error shape

```
Error: tool argument :amount requires an explicit type assertion — wrap it: (s/number 37)
```

The `<kind>` derives from the tool's declared JSON-Schema property type
(`integer`→`s/integer`, … `object`→`s/object`, `array`→`s/array`, absent→`s/string` as the
safest default); the preview is the argument's own value via the existing 60-char-capped
preview. Model-recoverable in one turn: names the arg, shows the exact wrap, echoes the value.
Construction lives in `bind.ts`.

## 5. T-layer future note

Under the typed constrained-decode rework, tool-arg slots become `Attested<number>` branded
slots: the only expressions inhabiting the type are `s/*` applications and tool-call results —
the wrap becomes **structurally forced by the sampler's mask**, and the runtime check degrades
to a belt-and-braces assert that never fires. The runtime design here is the semantics; the
typed layer makes wrong states unrepresentable at generation time. (The same brand gives the
harvest printer an honest signature: `s/number : number → Attested<number>`.)
