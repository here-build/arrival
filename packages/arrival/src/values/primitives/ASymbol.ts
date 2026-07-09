import { CLASS } from "../../well-known-symbols.js";
import { type RunContext } from "./RunContext.js";
import { AValue, EMPTY_PROVENANCE } from "./AValue.js";
import { chargeHeap } from "../../heap-budget.js";
import type { SchemeStringLike, SchemeValue } from "../types.js";
import { isSchemeString, isString } from "../types.js";
import { nil } from "./ANil.js";
import type { CallResult } from "./ACallable.js";

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

/** A real keyword name: `:`-prefixed, length > 1 (a bare `:` is not one) — matches
 *  `values/lineage.ts`'s `memberRead`/`type-layer/lower.ts`'s `isKeyword`. */
function isKeywordName(name: string): name is string {
  return typeof name === "string" && name.length > 1 && name.startsWith(":");
}

export class ASymbol extends AValue {
  static [CLASS] = "symbol";
  // Interning is per run context — see `internTables` / `internTableFor` above.
  /** Special symbol markers. `literal` is `unique symbol`-typed (the `Symbol.for` registry
   *  value is unchanged) so the gensym literal slot can be a DECLARED computed field below —
   *  a single typed key, not the broad symbol index signature esbuild rejects. Written by
   *  `gensym`'s `hidden_prop(symbol, "__literal__", name)` (reader/values-repr.ts); `name` is
   *  a string (named gensym) or number (anonymous `#:gN`); a gensym minted via the
   *  no-double-gensym path carries no slot at all — hence `?` + `string | number`. */
  static readonly literal: unique symbol = Symbol.for("__literal__");
  static readonly object = Symbol.for("__object__");
  readonly kind = "symbol" as const;
  /** Interned symbols carry their string name; a GENSYM carries a raw ES6 `symbol`
   *  as its name — the symbol IS the uniqueness (uninterned by construction, no
   *  capture in macro expansion). Every reader must handle both arms. */
  declare __name__: string | symbol;
  declare [ASymbol.literal]?: string | number;

  constructor(
    ctx: RunContext,
    name: string | symbol | SchemeStringLike,
    provenance: ReadonlySet<number> = EMPTY_PROVENANCE,
    intern: symbol | true = true,
  ) {
    super(ctx, provenance);
    // Unwrap SchemeStringLike to plain string; a raw ES6 symbol (gensym carrier) passes through.
    const unwrapped: string | symbol = isSchemeString(name) ? name.valueOf() : name;

    // A keyword redirects to AKeywordSymbol — a real subclass with a statically-declared
    // `apply` method, not a per-instance patch. `new.target` distinguishes "someone called
    // `new ASymbol(':a')` directly" (redirect) from "AKeywordSymbol's own super() call"
    // (already the right class — proceed as normal below). The redirect happens before
    // interning so the CACHED instance (whichever branch mints or hits it) is always the
    // correctly-typed one.
    if (new.target === ASymbol && typeof unwrapped === "string" && isKeywordName(unwrapped)) {
      return new AKeywordSymbol(ctx, unwrapped, provenance, intern);
    }

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
    // Bar-quoted `|...|` round-trip (R7RS §7.1.1 write syntax): quote when asked AND the
    // name needs it — empty (`""` has no unquoted spelling at all), contains a bar/backslash
    // (both of which the reader would otherwise treat as a delimiter/escape starter), or
    // contains a character that breaks unquoted symbol syntax (whitespace, a bracket/quote
    // delimiter, or a leading `;` comment starter). Only `|` and `\` need escaping inside the
    // bars — every other character (including literal whitespace) is legal there verbatim.
    if (quote && typeof str === "string" && (str === "" || /[|\\\s()[\]']|^;/.test(str))) {
      const escaped = str.replaceAll(/[|\\]/g, (char) => `\\${char}`);
      return `|${escaped}|`;
    }
    return String(str);
  }

  // Print protocol — the bare symbol name (printer get_native_types calls toString(quote=false)).
  ["arrival/print"](): string {
    return this.toString();
  }

  literal(): string {
    if (this.is_gensym()) {
      // The declared `[ASymbol.literal]` slot is `string | number | undefined`:
      // a named gensym stored its source name, an anonymous `#:gN` stored its
      // counter (number), and a no-double-gensym mint carries no slot at all.
      // Coerce to the `string` contract; fall back to the symbol's printed form.
      const lit = this[ASymbol.literal];
      return lit === undefined ? this.toString() : String(lit);
    }
    // Non-gensyms always have string names
    return this.__name__ as string;
  }

  valueOf(): string | symbol {
    // Returned raw — used as environment keys (a gensym's ES6-symbol name is a
    // legal, collision-free Map/Record key like any string).
    return this.__name__;
  }

  // Setoid — symbol ≡ symbol with the same `__name__`; `===` works for both string names and
  // gensym ES6 symbols (interned identity). Mirrors `ASymbol.is`.
  ["arrival/tagless-final/equals"](other: unknown): boolean {
    return other instanceof ASymbol && this.__name__ === other.__name__;
  }

  // Ord (extends Setoid) — lexicographic over STRING names. A gensym's `__name__` is an ES6
  // symbol with no meaningful order — falling back to `String(...)` gives a STABLE total
  // order within a run (Symbol toString is stable), so totality/antisymmetry/transitivity hold.
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

  ["arrival/toJS"](): string {
    // Apostrophe-prefix indicates "this is a scheme symbol, not a string."
    return `'${isString(this.__name__) ? this.__name__ : symbol_to_string(this.__name__ as symbol)}`;
  }

  /** See UNINTERNED sentinel doc. */
  withProvenance(p: ReadonlySet<number>): ASymbol {
    return new ASymbol(this.ctx, this.__name__, p, UNINTERNED);
  }
}

/**
 * A `:`-prefixed keyword — the ONLY difference from `ASymbol` is this statically-declared
 * `apply`, so `(:key obj)` dispatches through the ordinary `is_applyable`/`fn[tf("apply")]`
 * call-dispatch path (evaluator.ts) like any other callable, no special-cased resolver.
 * `ASymbol`'s own constructor redirects here for every keyword-shaped name — never
 * constructed directly by call sites, so `instanceof ASymbol` still holds everywhere a
 * keyword is used as a plain symbol.
 *
 * Applied to nothing, a keyword returns itself (point-free/composition use — `(compose :a
 * :b)`). Applied to one value, it hands ITSELF to that value's own `get` (not a folded
 * string) so the target decides how to fold/match it — no centralized accessor call here.
 */
export class AKeywordSymbol extends ASymbol {
  ["arrival/tagless-final/apply"](args: SchemeValue[], runCtx: RunContext, _canBounce = false): CallResult {
    if (args.length === 0) return this;
    const target = args[0] as unknown as Record<string, unknown> | null | undefined;
    const getter = target?.["arrival/tagless-final/get"];
    return typeof getter === "function" ? (getter.call(target, this, runCtx) as CallResult) : nil;
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
// INTEROP BOUNDARY: ASymbol tracks gensym/literal metadata via well-known symbols
// (`literal`, `object`); symbol-to-field auto-resolution would otherwise expose any class-
// or prototype-level property to inference-plane scheme. This marker blocks inherited-
// property access on instances. Interning lives in the module-scope `internTables` WeakMap
// (not a class member), so it isn't symbol-field reachable at all.
// ============================================================================
