# Strategy: minimal symbol factories + honest types

Status: active rework. Canonical template: `symbol.rosetta` + `ARosettaProcedure`.

## Goals

1. **Problems glow where they live** — illegal `input` / `output` / `inputRest` slots, not the factory return.
2. **Factories are pure bag-builders** — normalize schemas, resolve defaults, close bake-invariant helpers, `new Procedure(opts)`.
3. **Classes own instance truth** — ctor validates opts (mode-gated); apply owns the spine (or installed body for cycle reasons).
4. **No quasi-error returns** — do not return `ContractKindMismatch` as a fake procedure type.

## Compile-time ban (contract argument)

**Do not** put the ban on the factory return type (`CrossingResult` / `ContourResult` as return).

**Do** constrain the `contract` parameter:

```ts
// _bake.ts
type NoContourBrand<T>  = HasBrand<T, ContourOnly>  extends true ? never : T;   // negative
type NoCrossingBrand<T> = HasBrand<T, CrossingOnly> extends true ? never : T;

type CrossingContract<I, O, Rest> =
  Contract<I, O, Rest> &
    (HasBrand<I, ContourOnly> extends true ? { input: ContractKindMismatch<"…input…"> } : unknown) &
    (HasBrand<Rest, ContourOnly> extends true ? { inputRest: ContractKindMismatch<"…"> } : unknown) &
    (HasBrand<O, ContourOnly> extends true ? { output: ContractKindMismatch<"…output…"> } : unknown);

// factory
function rosetta(tpl) {
  return <const I extends VectorSpec, const O extends VectorSpec, const Rest extends RestSpec = undefined>(
    contract: CrossingContract<I, O, Rest>,
    impl: Impl<I, O, Rest>,
    opts?,
  ): ARosettaProcedure => { … };
}
```

| Kind | Contract param | Banned brand |
|---|---|---|
| rosetta | `CrossingContract` | ContourOnly (`z.schemeValue`) |
| native / sequence / define | `ContourContract` | CrossingOnly (`z.dynamic`, `z.instance`) |

**Why not `I extends NoContourBrand<I>`?** TypeScript rejects circular constraints on type parameters. Field intersection after free inference is the working form of the same negative idea.

**Legal arm must be type identity** (`Contract<I,O,Rest>`), not a mapped rewrite of every slot — otherwise tuple impl inference collapses (historical failure mode, §1.7).

Deprecated: `CrossingResult` / `ContourResult` as **return** wrappers (kept temporarily as aliases for any residual callers).

## Runtime: where asserts live

- **Factory** (still): `assertProvenanceRoleShape` / `assertCacheClassShape` / `extractCallbackRoles` — these live in `_bake.ts` and pull scheme-zod. `ARosettaProcedure` **must not** import `_bake` at runtime (ACallable → class → _bake → scheme-zod → membrane → ACallable marshal TDZ).
- **Ctor** (light): mode check (`membrane` XOR `hostApply`); axis consistency (`forwards` ↔ `pipe`, `sink` ↔ sink role) without `_bake`.
- Ideal later: move assert* to a leaf module with no scheme-zod/ACallable edge, then ctor can own full gates.

## Factory shape (minimal)

```
parseNameDoc
→ normalize schemas
→ resolve defaults (provenance, cacheClass, callbackRoles)
→ bake-invariant helpers (dynamicSlotPositions, adoptArgs, …) → bag
→ new Procedure({ name, arity, contract, axes, membrane | hostApply | impl })
→ return procedure  // bare, no cast to Result
```

Delete:

- `as CrossingResult<…>` / `as ContourResult<…>`
- dual `contract.run` + procedure `#impl` adapters (prefer apply path ownership)
- dead `strategy: { provenance }` unless strategy is real
- novel-length comments; keep short why + doc link

## Apply ownership

| Class | Apply body home |
|---|---|
| `ARosettaProcedure` | Installed from `symbols/rosetta.ts` (`_installRosettaMembraneApply`) — class file cannot import scheme-zod/membrane without ACallable marshal TDZ |
| `ANativeProcedure` | Prefer `#impl` or future contour apply; kill dual `run` on sequence/tagless when touching those |

## Per-symbol checklist (agents)

For **native**, **sequence**, **define** (and any ContourResult residual):

1. Factory param: `ContourContract<I,O,Rest>` (define: adapt constant-schema overload).
2. Return type: bare `ANativeProcedure` / `DefineSymbolDef` (whatever the real value is).
3. Generics: free `const I extends VectorSpec` (no circular `NoCrossingBrand<I>`).
4. Move axis asserts into procedure ctor if not already (native: shared `ANativeProcedure` ctor).
5. Drop return casts; drop Result from capability inject types.
6. Update `@ts-expect-error` tests in `contract-kind-brand.test-d.ts` — errors should still fire; prefer them on the contract object if the harness allows.
7. Comment pass: §1.7 style only.

**tagless / taglessGuard / keyword / macro / value / alias** — no Contract slot brands; skip ContourContract unless they grow contracts.

## Verification

- `contract-kind-brand.test-d.ts` — all negative `@ts-expect-error` still required; positives clean.
- Runtime: symbol / cache-class / kwargs / rosetta membrane smoke.
- Healthy `impl` arg types still precise (spot-check one tuple contract).

## Reference implementation

- Types: `common/symbols/_bake.ts` §1.7 (`CrossingContract`, `ContourContract`, `NoContourBrand`, `NoCrossingBrand`)
- Factory: `common/symbols/rosetta.ts`
- Class: `values/primitives/ARosettaProcedure.ts` (ctor asserts)
- Inject: `common/capability.ts` `RosettaTag` / `NativeTag`
