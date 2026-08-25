# @inhuman.tools/arrival-serializer

S-expression serializer for Arrival — converts JavaScript values to Scheme/Lisp s-expressions for LLM-facing output. It optimizes for token-efficient, human-readable entity representation, **not** round-trip fidelity: it does not yet guarantee lossless reconstruction.

Serialization is two stages: `toSExpr` builds an s-expression (a plain JS array IR you can spread one representation inside another), and `formatSExpr` pretty-prints it. Custom types control their own form through `Symbol.toSExpr`.

## Installation

```bash
pnpm add @inhuman.tools/arrival-serializer
```

## Quick Start

```typescript
import { toSExpr, formatSExpr, toSExprString } from '@inhuman.tools/arrival-serializer';

// Basic values
toSExprString(42);              // "42"
toSExprString("hello");         // 'hello' (simple strings unquoted)
toSExprString("with space");    // '"with space"' (quoted only when needed)
toSExprString([1, 2, 3]);       // '[1 2 3]'
toSExprString({ x: 10, y: 20 }); // '{:x 10 :y 20}'

// Custom serialization
class Point {
  constructor(public x: number, public y: number) {}

  [Symbol.SExpr]() { return "Point"; }          // optional head-tag override
  [Symbol.toSExpr](ctx) {
    return [ctx.keyword('x'), this.x, ctx.keyword('y'), this.y];
  }
}

toSExprString(new Point(10, 20)); // '(Point :x 10 :y 20)'
```

## Custom Serialization

Implement `Symbol.toSExpr(ctx)` returning an array of parts. The serializer prepends a head tag and recurses into every part, applying `Symbol.toSExpr` again where present and otherwise following standard rules. **You never wrap properties** — a plain object among the parts auto-converts to `{:key value …}`.

The head tag resolves through this fallback chain (see the dispatch site in `serializer.ts`):

```
this[Symbol.SExpr]?.() ?? this.displayName ?? this.constructor.displayName ?? this.name ?? this.constructor.name
```

The `ctx` object provides the leaf constructors:

- `ctx.symbol(value)` — unquoted symbol
- `ctx.keyword(value)` — `:value`
- `ctx.quote(value)` — `'value`
- `ctx.string(value)` — `"value"`
- `ctx.expr(head, ...args)` — `(head arg1 arg2)`

## Optimizing Representations

Baseline output is already at least as compact as JSON, so optimize only the hottest, most data-heavy entities. Each technique shrinks a representation *while adding meaning*; applied systematically at data-heavy locations they yield materially fewer tokens than minified JSON and stay more readable than formatted JSON.

- **Type + name + id** — `(User 'abc123 "John Doe")`: the head names the entity type, a quoted symbol marks the identifier, a string carries the display name.
- **Flags as keywords** — emit a bare `:free-tier` when a boolean's presence alone is meaningful, and omit absent fields entirely (the same technique carries clear tags like `:div` / `:section` on render-tree nodes).
- **Named collections** — `(members (User …) (User …))` for an unordered collection field, rather than a positional list.
- **Views** — represent a *referenced* entity by a compact projection (`(User 'abc123 "John Doe")`) instead of inlining it in full. Doubles as cyclic-reference defense; a view may also project a *larger* structure when detail is the point (e.g. a component render tree).

> **Why named heads and quoted identifiers read well:** a named head gives a semantic anchor the way a variable name does over a raw address. High-entropy strings like UUIDs are naturally read as pointers, and the `'abc123` quote signals "reference, not data" — the same cognitive pattern as pointers in code, which models trained on code recognize immediately.

Whether these forms also improve AI *consumption* (not just density) is unvalidated — a domain worth researching.

## API

- `toSExpr(obj): SExpr` — value → s-expression IR.
- `formatSExpr(sexpr, indent?): string` — IR → pretty-printed string.
- `toSExprString(obj, indent?): string` — the two combined.
- `sexpr(tag, ...args): SExprDefinition` — tagged s-expression.

## Type Mappings

| JavaScript  | S-Expression                          |
|-------------|---------------------------------------|
| `null`      | `nil`                                 |
| `undefined` | `undefined`                           |
| Numbers     | Numbers (with BigInt support)         |
| Strings     | Unquoted when simple, `"quoted"` otherwise |
| Booleans    | `#t` / `#f`                           |
| Arrays      | `[...]`                               |
| Objects     | `{:key value ...}`                    |
| Symbols     | `:keyword`                            |
| Map         | `(map :key value ...)`                |
| Set         | `(set ...)`                           |
| Date        | ISO string                            |

## Scheme Integration

Built-in support for Arrival's Scheme runtime types (duck-typed by constructor name, exposed from `@inhuman.tools/arrival/reflect-internals`):

- `AExact` (exact integers / rationals) → Numbers or `num/denom`
- `AInexact` (floats / complex) → Numbers or `real+imagi`
- `ASymbol` → Symbols/keywords
- `AString` → single-quoted or template strings
- `ACharacter` → character literals (`#\char`)
- `APair` / `ANil` → lists
- `Values` → multiple return values
- `EOF`, `Macro`, `Syntax`, `InputPort`/`OutputPort` → reader-friendly placeholders

## Part of Arrival

- **@here.build/arrival-env** — type definitions and protocols
- **@inhuman.tools/arrival** — the Scheme interpreter, exposing runtime types (e.g. via `/reflect-internals`)
- **@inhuman.tools/arrival-serializer** — this package

## License

[MIT](./LICENSE.md).

