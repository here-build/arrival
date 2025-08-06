# @dappsnap/s-expressions

A powerful S-expression serialization library with custom protocol support via `Symbol.toSExpr` and `Symbol.SExpr`.

## Features

- Convert JavaScript objects to S-expressions
- Support for custom serialization via `Symbol.toSExpr` with rich context API
- Custom display names via `Symbol.SExpr`
- Proper formatting with intelligent indentation
- Type-safe with TypeScript
- Built-in support for Maps, Sets, Dates, and more
- Circular reference detection
- Clean separation between operators (unquoted) and arguments (quoted)

## Installation

```bash
npm install @dappsnap/s-expressions
```

## Basic Usage

```typescript
import { toSExpr, formatSExpr, toSExprString } from '@dappsnap/s-expressions';

// Convert primitives
toSExprString("hello")           // => "hello"
toSExprString(42)               // => 42
toSExprString(true)             // => true
toSExprString(null)             // => nil

// Convert arrays to lists
toSExprString([1, 2, 3])        // => (list 1 2 3)

// Convert objects to maps
toSExprString({ a: 1, b: 2 })   // => (map :a 1 :b 2)

// Symbols become keywords
toSExprString(Symbol.for("test")) // => :test

// Dates, Maps, and Sets
toSExprString(new Date('2024-01-01')) // => "2024-01-01T00:00:00.000Z"
toSExprString(new Map([["a", 1]])) // => (map :a 1)
toSExprString(new Set([1, 2, 3])) // => (set 1 2 3)
```

## Custom Serialization

Objects can define their own S-expression representation using `Symbol.toSExpr` with a rich context API:

```typescript
class Component {
  constructor(
    public type: string,
    public props: Record<string, any>
  ) {
  }

  // Optional: Custom display name
  [Symbol.SExpr]() {
    return this.type;
  }

  // Define serialization with context helpers
  [Symbol.toSExpr](context) {
    return [
      context.keyword("props"),
      ...Object.entries(this.props).flatMap(([k, v]) => [
        context.keyword(k), v
      ])
    ];
  }
}

const button = new Component('Button', {
  onClick: 'handleClick',
  disabled: false
});

toSExprString(button)
// => (Button
//      :props
//      :onClick "handleClick"
//      :disabled false)
```

### Context API

The context object provides these helpers:

- `context.keyword(str)` - Creates a keyword (e.g., `:name`)
- `context.symbol(str)` - Creates an unquoted symbol
- `context.quote(str)` - Creates a quoted string (default for strings)
- `context.expr(head, ...args)` - Creates a nested S-expression

```typescript
class MathExpression {
  [Symbol.toSExpr](context) {
    return [
      context.expr('add',
        context.expr('multiply', 2, 3),
        context.expr('subtract', 10, 5)
      ),
      context.keyword('symbols'),
      context.symbol('x'),
      context.symbol('y')
    ];
  }
}

toSExprString(new MathExpression())
// => (MathExpression
//      (add
//        (multiply 2 3)
//        (subtract 10 5))
//      :symbols x y)
```

## Transformation Rules

1. **Operators** (first element) are never quoted
2. **Strings** as arguments are always quoted
3. **Keywords** (`:symbol`) are never quoted
4. **Arrays** → `(list ...)`
5. **Objects** → `&(:key value ...)` (Scheme-style records)
6. **Maps** → `(map :key value ...)`
7. **Sets** → `(set value ...)`
8. **Symbols** → `:keywords`
9. **null** → `nil`
10. **undefined** → `undefined`

## API

### Core Functions

- `toSExpr(obj: any): SExpr` - Convert any value to S-expression
- `formatSExpr(sexpr: SExpr, indent?: number): string` - Format S-expression as string
- `toSExprString(obj: any, indent?: number): string` - Convert and format in one step

### Symbols

- `Symbol.toSExpr` - Symbol for custom serialization method
- `Symbol.SExpr` - Symbol for custom display name
- `SEXPR_TAG` - Internal symbol to mark S-expression definitions

### Helpers

- `sexpr(tag: string, ...args: any[]): SExprDefinition` - Create S-expression definition
- `smap(obj: Record<string, any>): SExprDefinition` - Create Scheme record definition
- `slist(...items: any[]): SExprDefinition` - Create list definition

## Examples

### Complex nested structures

```typescript
const data = {
  name: "test",
  items: [1, 2, 3],
  meta: { count: 3, active: true }
};

toSExprString(data);
// Output:
// &(:name "test"
//   :items (list 1 2 3)
//   :meta &(:count 3 :active true))
```

### Static properties and display names

```typescript
class NamedClass {
  static displayName = "CustomName";

  [Symbol.toSExpr](context) {
    return [
      context.keyword("initialized"),
      true
    ];
  }
}

toSExprString(new NamedClass())
// => (CustomName :initialized true)
```

### Circular reference detection

```typescript
const obj: any = { name: "test" };
obj.self = obj; // circular reference

try {
  toSExprString(obj);
} catch (e) {
  console.log(e.message); // => "Circular reference detected"
}
```

## License

MIT
