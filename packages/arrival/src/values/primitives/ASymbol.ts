import { CLASS } from "../../well-known-symbols.js";
import { CONSTANT_CTX, type RunContext } from "./RunContext.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { markInteropBoundary } from "../../interop-access.js";
import { chargeHeap } from "../../heap-budget.js";
import type { SchemeStringLike } from "../types.js";
import { isSchemeString, isString } from "../types.js";

type SchemeSymbolName = string | symbol;

/**
 * Provenance × interning invariant: `SchemeSymbol.list[name]` is the canonical
 * empty-provenance instance shared by every reader. `withProvenance` must NOT
 * replace it (that would stamp every other reader with one call-site's
 * provenance); instead it mints a fresh uninterned copy via this sentinel.
 * Safe because `SchemeSymbol.is` compares `__name__`, not reference.
 *
 * Lineage: symbol interning is hash-consing (Ershov, 1958) / the flyweight
 * pattern — canonical shared instances keyed by name.
 */
const UNINTERNED = Symbol("UNINTERNED");

// Per-RUN-CONTEXT flyweight intern tables (replaces the former process-global
// `ASymbol.list`). The ctx a symbol is minted with decides its table — hence both
// its LIFETIME and its run PARAMETERS:
//   • CONSTANT_CTX → the permanent bootstrap table (quote/vector/… — a fixed set).
//   • a run ctx    → a per-run table, collectable once the run ctx is GC'd, so a
//     `(string->symbol unique)` loop no longer leaks permanent global entries.
// A `Map` (not the old null-proto Record) is inherently key-pollution-safe —
// `(string->symbol "__proto__")` sets a Map entry, never reaching Object.prototype.
// Interning stays pure flyweight (eq? compares `__name__`, not reference — see
// `equals`/`is`), so per-ctx scoping changes no symbol semantics.
const internTables = new WeakMap<RunContext, Map<string, ASymbol>>();
function internTableFor(ctx: RunContext): Map<string, ASymbol> {
  let table = internTables.get(ctx);
  if (table === undefined) {
    table = new Map();
    internTables.set(ctx, table);
  }
  return table;
}

export class ASymbol extends AValue {
  static [CLASS] = "symbol";
  readonly kind = "symbol" as const;
  // Interning is per run context — see `internTables` / `internTableFor` above.
  // Note: gensyms store their literal name at this[SchemeSymbol.literal]
  // We can't declare the index signature with esbuild
  // Special symbol markers
  static readonly literal = Symbol.for("__literal__");
  static readonly object = Symbol.for("__object__");
  declare __name__: SchemeSymbolName;

  constructor(
    ctx: RunContext,
    name: SchemeSymbolName | SchemeStringLike,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
    intern: symbol | true = true,
  ) {
    super(ctx, provenance);
    // Unwrap SchemeStringLike to plain string
    const unwrapped: SchemeSymbolName = isSchemeString(name) ? name.valueOf() : name;

    if (intern !== UNINTERNED && typeof unwrapped === "string") {
      const table = internTableFor(ctx);
      const hit = table.get(unwrapped);
      // Flyweight HIT: return the canonical shared instance — no allocation.
      if (hit !== undefined) {
        return hit;
      }
      // MISS: a fresh symbol is an allocation — charge the run's heap meter so a
      // `(string->symbol unique)` mint-loop hits the budget instead of growing
      // unbounded. An unmetered run (incl. CONSTANT_CTX bootstrap) → chargeHeap no-ops.
      chargeHeap(ctx, 1);
      this.__name__ = unwrapped;
      table.set(unwrapped, this);
      return;
    }

    this.__name__ = unwrapped;
  }

  static is(symbol: unknown, name: string | ASymbol | RegExp): boolean {
    return (
      symbol instanceof ASymbol &&
      ((name instanceof ASymbol && symbol.__name__ === name.__name__) ||
        (typeof name === "string" && symbol.__name__ === name) ||
        (name instanceof RegExp && typeof symbol.__name__ === "string" && name.test(symbol.__name__)))
    );
  }

  toString(quote?: boolean): string {
    if (isSymbol(this.__name__)) {
      return symbol_to_string(this.__name__);
    }
    const str = this.valueOf();
    // those special characters can be normal symbol when printed
    if (quote && typeof str === "string" && /(^;|[\s()[\]'])/.test(str)) {
      return `|${str}|`;
    }
    return String(str);
  }

  // Print protocol — the bare symbol name (printer get_native_types calls toString(quote=false)).
  ["arrival/print"](): string {
    return this.toString();
  }

  literal(): string {
    if (this.is_gensym()) {
      return (this as unknown as Record<symbol, string>)[ASymbol.literal];
    }
    // Non-gensyms always have string names
    return this.__name__ as string;
  }

  serialize(): SchemeSymbolName | [string] {
    if (isString(this.__name__)) {
      return this.__name__;
    }
    return [symbol_to_string(this.__name__ as symbol)];
  }

  valueOf(): SchemeSymbolName {
    // For symbols, return the symbol itself (used as environment keys)
    // For strings, return the string
    return this.__name__;
  }

  // Setoid (Fantasy Land). Symbol ≡ symbol with the same `__name__` — `===`
  // works for both string names and gensym ES6 symbols (interned identity).
  // Mirrors `SchemeSymbol.is` (which compares `__name__`), preserving
  // structuralEqual / equal? behavior. (algebras-in-entities migration.)
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof ASymbol && this.__name__ === other.__name__;
  }

  // Ord (Fantasy Land, extends Setoid). Lexicographic over STRING names.
  // A gensym's `__name__` is an ES6 symbol with no meaningful order — falling
  // back to `String(...)` gives a STABLE total order within a run (Symbol
  // toString is stable), so totality/antisymmetry/transitivity still hold.
  ["arrival/tagless-final/lte"](other: unknown): boolean {
    return other instanceof ASymbol && String(this.__name__) <= String(other.__name__);
  }

  // Type predicate — `(symbol? x)` (a `symbol.taglessGuard`) asks the receiver instead of the
  // builtin reaching around with `instanceof ASymbol`. A Symbol answers #t; others default #f.
  ["arrival/tagless-final/symbol?"](): boolean {
    return true;
  }

  is_gensym(): boolean {
    return is_gensym(this.__name__);
  }

  toJs(): string {
    // Apostrophe-prefix indicates "this is a scheme symbol, not a string."
    return `'${isString(this.__name__) ? this.__name__ : symbol_to_string(this.__name__ as symbol)}`;
  }

  /** See UNINTERNED sentinel doc. */
  withProvenance(p: ReadonlySet<number>): ASymbol {
    return new ASymbol(this.ctx, this.__name__, p, UNINTERNED);
  }
}

// ── Symbol helpers ──
function isSymbol(x: unknown): x is symbol {
  return typeof x === "symbol" || (typeof x === "object" && Object.prototype.toString.call(x) === "[object Symbol]");
}

function symbol_to_string(obj: symbol): string {
  return obj.toString().replace(/^Symbol\(([^)]+)\)/, "$1");
}

function is_gensym(symbol: unknown): boolean {
  if (typeof symbol === "symbol") {
    return /^Symbol\(#:/.test(symbol.toString());
  }
  return false;
}

// ============================================================================
// INTEROP BOUNDARY
// ============================================================================
// War story (2026-05-28 audit): SchemeSymbol tracks gensym/literal metadata via
// well-known symbols (`SchemeSymbol.literal`, `SchemeSymbol.object`), and
// symbol-to-field auto-resolution would expose any class- or prototype-level
// property to inference-plane scheme. Marking the boundary blocks inherited-property
// access on instances. (The former static `list` intern table — a read-write
// poisoning surface — is gone: interning now lives in the module-scope per-ctx
// `internTables` WeakMap above, not a class member, so it isn't symbol-field
// reachable at all.)
// ============================================================================
markInteropBoundary(ASymbol);
