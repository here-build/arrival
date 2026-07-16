/**
 * RUNTIME IMPORTS — E1b's cut-over (engine plan §2 E1b): commits the
 * `RuntimeRef`→`Ref` resolution the dissolved `frame/` pass used to own. The
 * SYMBOL SET now comes from the model (`sm.importsOf`, unioned over the
 * program's top-level forms — see `oracle/harness.ts`'s `compileGreenfield`)
 * instead of a fresh post-render tree scan; this module's own job shrinks to
 * committing that already-decided set onto the tree: prepend the runtime
 * module's `Import` decl, rewrite every surviving `RuntimeRef` node to a
 * `Ref` against its manifest-named `Binding`.
 *
 * E2 UPDATE (engine plan §2 E2, second half — dissolves a caller-side rule
 * this header used to state): this used to read "unioned over the program's
 * PEEPHOLED top-level forms" — `compileGreenfield` had to query `sm.importsOf`
 * over a separate `peephole()` pass's OUTPUT, because that pass folded
 * symbols (`infer` → `infer/scalar`) `sm.coreform`'s own forms never showed.
 * That pass, and the caller-side rule it forced, are both gone: folding now
 * happens INSIDE `sm.idiomAt` (a per-node view the walker consults inline,
 * `walker/walk.ts`'s `lowerApp`), and `importsOf`'s own synthetic walk
 * (`model.ts`'s `computeImportsOf`) consults the SAME view — so `importsOf`
 * queried over `sm.coreform`'s ORIGINAL forms already agrees with the
 * emitted imports, by construction. See `model.ts`'s `importsOf` doc for the
 * full account.
 *
 * ── Why this can't run inside walk()'s own census→allocate→materialize call ──
 * The SHARED-BINDINGS view's eligibility check (`naming/shared-bindings.ts`,
 * the dissolved `legibility/cse.ts`'s successor) keys off
 * `n.callee.t === "RuntimeRef"` to recognize a hoistable call — the marker
 * must survive that pass undisturbed. Resolving RuntimeRef→Ref any earlier
 * (inside walk()'s own materialize step, alongside the rest of E1a's naming
 * commit) would blind it to registry calls entirely. So this step keeps the
 * pipeline POSITION `frame` used to occupy — after the asyncness
 * materializer (naming/asyncness.ts's `materializeAsyncness`), before render
 * — a genuine tree-shape constraint, not a reluctance to relocate the
 * DECISION backward (that decision — which manifest name each symbol gets —
 * already lives one phase back, in ../walker/walk.ts's naming phase; see the
 * next section). Per the engine plan's own fallback clause: this is "the
 * materializer step", not a re-decided post-pass.
 *
 * ── E1c update, honestly: this ordering constraint did NOT dissolve ─────────
 * E1c (engine plan §2 E1c) killed the standalone `async-ify/` PASS —
 * asyncness is now `SchemeSemanticModel.asyncnessOf` (a view,
 * naming/asyncness.ts) plus `materializeAsyncness` (the mechanical rewrite,
 * same module) — but the STRUCTURAL reason this file still has to run AFTER
 * that materializer is IDENTICAL to the reason it used to run after the
 * dissolved `asyncIfy`: `materializeAsyncness`'s own seed detection
 * (`AsyncnessFacts.callType`'s `RuntimeRef` branch) identifies a
 * promise-seeded call by its `RuntimeRef` SYMBOL NAME — which only resolves
 * correctly while the node is STILL a `RuntimeRef`, not yet rewritten to a
 * plain `Ref` against its manifest-named binding. Swap this file's position
 * to run BEFORE the asyncness materializer and every `RuntimeRef` it needs
 * to seed from has already become an opaque `Ref`: the whole-program "did
 * any seed fire" census silently answers "no" and every promise-typed call
 * renders un-awaited — a correctness regression, not a style miss. So: two
 * independent passes (the shared-bindings materializer's eligibility check,
 * the asyncness materializer's seed detection) key off the SAME `RuntimeRef`
 * marker, each for its own independent reason, and this file must run after
 * BOTH. The dissolved pass's NAME is gone from this sentence; its constraint
 * is not — it moved with the mechanism, to `naming/asyncness.ts`.
 *
 * ── No collision ladder — the aliasing knowledge that actually moved ────────
 * `frame`'s dissolved implementation re-scanned the WHOLE finished tree for
 * every already-spoken-for JS name (`takenNamesOf`) and suffixed on collision
 * (`_2`, `_3`, …) — an independently re-derived policy, redundant with a
 * decision E1a's allocation phase already makes. That ladder is now dead code
 * BY CONSTRUCTION, not merely by observation: walker/walk.ts's own naming
 * phase reserves every manifest export name this unit's surviving
 * `RuntimeRef`s will need (`stillNeeded`, walk.ts's own comment) at
 * allocation time, and `@here.build/lexical-namer` propagates a reservation
 * to EVERY scope in the tree (its own "effective reservations" doc — see
 * naming/allocate.ts's header). So no user `Binding` `materializeNames`
 * commits can ever hold that text — the import's local name is therefore
 * always exactly `manifest[symbol]`, unconditionally, never a ladder-resolved
 * guess re-deciding what allocation already decided.
 *
 * This relies on the `RuntimeRef` symbol set being STABLE from walk() through
 * the shared-bindings materializer and the asyncness materializer — neither
 * mints a new registry call nor folds one away this wave (verified: the
 * shared-bindings view and `materializeAsyncness`'s seed detection both only
 * READ `RuntimeRef` call targets, never construct one; `sm.idiomAt`'s folds
 * happen INSIDE `walk()` itself, at `lowerApp` — before ANY `RuntimeRef` this
 * module ever sees is minted, never a separate stage this file's own
 * ordering could race). `../__tests__/model-imports-agree.test.ts` is the
 * regression guard for this invariant.
 *
 * Two throws remain, both Law F ("never wrong, always visible"):
 *  - a required symbol with no manifest row — the door. Message text
 *    preserved VERBATIM from the dissolved `frame/frame.ts` ("frame door: …")
 *    because two committed door fixtures
 *    (`__tests__/fixtures/emitted/inhuman-geo.error.txt`,
 *    `…/inhuman-reference-interview.error.txt`) byte-pin it; only the class
 *    name changed to fit this module's new home.
 *  - a `RuntimeRef` node surviving in `unit` whose symbol was NOT in the
 *    caller-supplied `symbols` set — an internal invariant violation (the
 *    model's `importsOf` under-counted relative to the real tree) that must
 *    never silently mis-name a binding.
 *  - (belt-and-suspenders, orthogonal to both of the above) two DIFFERENT
 *    required symbols resolving to the SAME manifest export name — a
 *    STAGE0 authoring bug the reservation mechanism above does not guard
 *    against (reservation protects against USER bindings colliding with an
 *    import; it says nothing about the manifest itself being non-injective).
 */
import { mapChildren } from "../legibility/tree.js";
import type { CompilationUnit, Decl, ImportName, R } from "../residual/types.js";
import { Binding as mkBinding, Import, type Binding } from "../residual/types.js";
import { STAGE0 } from "../runtime/stage0.js";

export interface MaterializeImportsOptions {
  /** The whole-program required-symbol set — sourced from `sm.importsOf`,
   *  unioned over the program's top-level forms (see `oracle/harness.ts`'s
   *  `compileGreenfield`). Not re-derived here: `model-imports-agree.test.ts`
   *  is the proof that this set and the tree's actual `RuntimeRef` occurrences
   *  agree. */
  readonly symbols: ReadonlySet<string>;
  /** The import specifier the emitted module uses for the runtime module (the
   *  oracle harness stages `stage0` into the scratch dir and passes
   *  `"./stage0.mts"`; a real emitted project passes its own runtime path). */
  readonly runtimeModule: string;
  /** symbol → exported-name manifest; defaults to the stage-0 manifest. Override
   *  seam for tests and for later runtime stages. */
  readonly manifest?: Readonly<Record<string, string>>;
}

/** The dissolved `frame`'s compile-time refusal, relocated — message text
 *  preserved byte-for-byte (see the module header: two committed door
 *  fixtures pin it); only the class name changed. */
export class MaterializeImportsDoorError extends Error {
  readonly symbols: readonly string[];
  constructor(symbols: readonly string[]) {
    super(
      `frame door: ${symbols.map((s) => `\`${s}\``).join(", ")} ${symbols.length === 1 ? "is" : "are"} ` +
        `not supported by the runtime module yet — no manifest export exists. Add the shim + its STAGE0 ` +
        `manifest row in src/runtime/stage0.ts (constitution §4.4; the export set grows corpus-driven).`,
    );
    this.name = "MaterializeImportsDoorError";
    this.symbols = symbols;
  }
}

/**
 * Materialize `unit`'s runtime imports: prepend the `Import` decl, rewrite
 * every `RuntimeRef` to a `Ref`. Pure — an empty `symbols` set returns the
 * SAME reference (the identity fast-path ASYNC-IFY and the dissolved `frame`
 * both kept).
 */
export function materializeImports(unit: CompilationUnit, opts: MaterializeImportsOptions): CompilationUnit {
  if (opts.symbols.size === 0) return unit;
  const manifest = opts.manifest ?? STAGE0;

  const symbols = [...opts.symbols].sort(); // UTF-16 code-unit order — the §8 determinism convention
  const missing = symbols.filter((s) => manifest[s] === undefined);
  if (missing.length > 0) throw new MaterializeImportsDoorError(missing);

  const aliasOf = new Map<string, Binding>();
  const symbolOfExported = new Map<string, string>(); // manifest-injectivity guard — see module header
  const names: ImportName[] = symbols.map((symbol) => {
    const exported = manifest[symbol]!; // present — filtered by the door check above
    const claimant = symbolOfExported.get(exported);
    if (claimant !== undefined) {
      throw new Error(
        `materializeImports: the STAGE0 manifest is not injective — both \`${claimant}\` and \`${symbol}\` ` +
          `export as "${exported}"; every runtime symbol needs its own export name (src/runtime/stage0.ts).`,
      );
    }
    symbolOfExported.set(exported, symbol);
    aliasOf.set(symbol, mkBinding(exported));
    return { imported: exported }; // never aliased — collision with a user binding is impossible by
    // construction (see the module header), so `local` never needs to differ from `imported`.
  });

  const rewrite = (n: R): R => {
    if (n.t !== "RuntimeRef") return mapChildren(n, rewrite);
    const binding = aliasOf.get(n.symbol);
    if (binding === undefined) {
      throw new Error(
        `materializeImports: \`${n.symbol}\` occurs in the tree but is not in the model's importsOf set — ` +
          `the model and the walked tree disagree (see model-imports-agree.test.ts).`,
      );
    }
    return { t: "Ref", binding, origin: n.origin };
  };
  const rewriteDecl = (d: Decl): Decl => {
    switch (d.t) {
      case "FnDecl":
        return { ...d, body: { ...d.body, stmts: d.body.stmts.map(rewrite) } };
      case "ConstDecl":
        return { ...d, init: rewrite(d.init) };
      case "DeclComment":
        return { ...d, decl: rewriteDecl(d.decl) };
      case "Import":
      case "ImportType":
      case "Export":
        return d;
    }
  };

  return {
    decls: [Import(names, opts.runtimeModule), ...unit.decls.map(rewriteDecl)],
    body: unit.body.map(rewrite),
  };
}
