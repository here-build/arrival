/**
 * RUNTIME IMPORTS — E1b: commits RuntimeRef→Ref using the multi-source runtime
 * manifest (`runtime/runtime-manifest.ts`): stage0 Scheme-texture shims and
 * ramda cold stdlib. See prior module history for pipeline ordering vs asyncness
 * and shared-bindings (RuntimeRef marker must survive those materializers).
 */
import { mapChildren } from "../legibility/tree.js";
import type { CompilationUnit, Decl, ImportName, R } from "../residual/types.js";
import { Binding as mkBinding, Import, type Binding } from "../residual/types.js";
import {
  RAMDA_MODULE,
  RUNTIME_LOCALS,
  RUNTIME_MANIFEST,
  type RuntimeEntry,
  type RuntimeSource,
} from "../runtime/runtime-manifest.js";

export interface MaterializeImportsOptions {
  /** Whole-program required-symbol set from `sm.importsOf`. */
  readonly symbols: ReadonlySet<string>;
  /**
   * Import specifier for the stage0 runtime module
   * (oracle: `./stage0.mts`; build: `./stage0.js` relative path).
   */
  readonly runtimeModule: string;
  /**
   * scheme → local name map for walk reservation parity. Defaults to
   * `RUNTIME_LOCALS`. Override only if you also pass the same map to
   * `WalkOptions.manifest`.
   */
  readonly manifest?: Readonly<Record<string, string>>;
  /** Full multi-source census; defaults to `RUNTIME_MANIFEST`. */
  readonly runtimeManifest?: Readonly<Record<string, RuntimeEntry>>;
  /** npm specifier for ramda (default `"ramda"`). */
  readonly ramdaModule?: string;
}

export class MaterializeImportsDoorError extends Error {
  readonly symbols: readonly string[];
  constructor(symbols: readonly string[]) {
    super(
      `frame door: ${symbols.map((s) => `\`${s}\``).join(", ")} ${symbols.length === 1 ? "is" : "are"} ` +
        `not supported by the runtime module yet — no manifest export exists. Add the shim + its ` +
        `RUNTIME_MANIFEST row in src/runtime/runtime-manifest.ts (and stage0.ts body when source is stage0).`,
    );
    this.name = "MaterializeImportsDoorError";
    this.symbols = symbols;
  }
}

const BUILTIN_SOURCE_ORDER: readonly RuntimeSource[] = ["ramda", "stage0"];

const sortNames = (names: ImportName[]): void => {
  names.sort((a, b) => {
    const al = a.local ?? a.imported;
    const bl = b.local ?? b.imported;
    return al < bl ? -1 : al > bl ? 1 : 0;
  });
};

/** Every `RuntimeRef.symbol` still living in the residual unit (post peephole/asyncness). */
function collectRuntimeRefSymbols(unit: CompilationUnit): Set<string> {
  const out = new Set<string>();
  const visit = (n: R): R => {
    if (n.t === "RuntimeRef") out.add(n.symbol);
    return mapChildren(n, visit);
  };
  const visitDecl = (d: Decl): void => {
    switch (d.t) {
      case "FnDecl":
        for (const s of d.body.stmts) visit(s);
        break;
      case "ConstDecl":
        visit(d.init);
        break;
      case "DeclComment":
        visitDecl(d.decl);
        break;
      default:
        break;
    }
  };
  for (const d of unit.decls) visitDecl(d);
  for (const s of unit.body) visit(s);
  return out;
}

/**
 * Materialize runtime imports: one Import decl per source module that is used,
 * rewrite every RuntimeRef to a Ref. Pure — empty symbols → same unit reference.
 *
 * Sources: ramda + stage0 (built-in), then `"pkg"` rows keyed by `entry.module`
 * (capability-owned runtimes — handlebars is the reference).
 *
 * Symbol set = `sm.importsOf` ∪ RuntimeRefs actually in the residual tree. The
 * second half closes the importsOf-disagree class (peepholes / asyncness can
 * introduce RuntimeRefs the model walk never saw — see model-imports-agree).
 */
export function materializeImports(unit: CompilationUnit, opts: MaterializeImportsOptions): CompilationUnit {
  const locals = opts.manifest ?? RUNTIME_LOCALS;
  const full = opts.runtimeManifest ?? RUNTIME_MANIFEST;
  const ramdaModule = opts.ramdaModule ?? RAMDA_MODULE;

  const fromTree = collectRuntimeRefSymbols(unit);
  const symbolSet = new Set<string>([...opts.symbols, ...fromTree]);
  if (symbolSet.size === 0) return unit;

  const symbols = [...symbolSet].sort(); // UTF-16 determinism
  void locals; // reserved for walk-parity override checks / future injectivity cross-check
  const unresolved = symbols.filter((s) => full[s] === undefined);
  if (unresolved.length > 0) throw new MaterializeImportsDoorError(unresolved);

  // Local-name injectivity across the whole unit
  const symbolOfLocal = new Map<string, string>();
  const aliasOf = new Map<string, Binding>();
  const byBuiltin = new Map<RuntimeSource, ImportName[]>();
  /** pkg module specifier → import names */
  const byPkg = new Map<string, ImportName[]>();

  for (const symbol of symbols) {
    const entry = full[symbol]!;
    if (entry.source === "pkg" && (entry.module === undefined || entry.module === "")) {
      throw new Error(
        `materializeImports: \`${symbol}\` has source "pkg" but no module specifier — ` +
          `RUNTIME_MANIFEST rows for capability packages must set module.`,
      );
    }
    const claimant = symbolOfLocal.get(entry.local);
    if (claimant !== undefined) {
      throw new Error(
        `materializeImports: runtime locals are not injective — both \`${claimant}\` and \`${symbol}\` ` +
          `bind as "${entry.local}"; every runtime symbol needs its own local name.`,
      );
    }
    symbolOfLocal.set(entry.local, symbol);
    aliasOf.set(symbol, mkBinding(entry.local));
    const name: ImportName =
      entry.imported === entry.local
        ? { imported: entry.imported }
        : { imported: entry.imported, local: entry.local };
    if (entry.source === "pkg") {
      const mod = entry.module!;
      const bucket = byPkg.get(mod) ?? [];
      bucket.push(name);
      byPkg.set(mod, bucket);
    } else {
      const bucket = byBuiltin.get(entry.source) ?? [];
      bucket.push(name);
      byBuiltin.set(entry.source, bucket);
    }
  }

  // Deterministic import decl order: ramda, stage0, then pkg modules (UTF-16 sort).
  const importDecls: Decl[] = [];
  for (const source of BUILTIN_SOURCE_ORDER) {
    const names = byBuiltin.get(source);
    if (names === undefined || names.length === 0) continue;
    sortNames(names);
    const from = source === "ramda" ? ramdaModule : opts.runtimeModule;
    importDecls.push(Import(names, from));
  }
  for (const mod of [...byPkg.keys()].sort()) {
    const names = byPkg.get(mod)!;
    sortNames(names);
    importDecls.push(Import(names, mod));
  }

  const rewrite = (n: R): R => {
    if (n.t !== "RuntimeRef") return mapChildren(n, rewrite);
    const binding = aliasOf.get(n.symbol);
    if (binding === undefined) {
      // Should be unreachable: symbolSet unions tree RuntimeRefs above.
      throw new Error(
        `materializeImports: \`${n.symbol}\` occurs in the tree but has no alias — ` +
          `internal materializeImports bug (see model-imports-agree.test.ts).`,
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
    decls: [...importDecls, ...unit.decls.map(rewriteDecl)],
    body: unit.body.map(rewrite),
  };
}
