# @dappsnap/s-expressions

A clean, abstract S-expression serialization library with custom protocol support via `Symbol.toSymbolicExpression`.

## Features

- Convert JavaScript objects to S-expressions
- Support for custom serialization via `Symbol.toSymbolicExpression`
- Proper formatting with indentation
- Type-safe with TypeScript
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
```

## Custom Serialization

Objects can define their own S-expression representation using the `Symbol.toSymbolicExpression` protocol:

```typescript
import { TO_SEXPR, SEXPR_TAG, sexpr } from '@dappsnap/s-expressions';

class Point {
  constructor(public x: number, public y: number) {}
  
  [TO_SEXPR]() {
    return [SEXPR_TAG, 'point', this.x, this.y];
  }
}

const p = new Point(10, 20);
toSExprString(p) // => (point 10 20)
```

## Transformation Rules

1. **Operators** (first element) are never quoted
2. **Strings** as arguments are always quoted
3. **Keywords** (`:symbol`) are never quoted
4. **Arrays** → `(list ...)`
5. **Objects** → `(map :key value ...)`
6. **Symbols** → `:keywords`
7. **null** → `nil`
8. **undefined** → `undefined`

## API

### Core Functions

- `toSExpr(obj: any): SExpr` - Convert any value to S-expression
- `formatSExpr(sexpr: SExpr, indent?: number): string` - Format S-expression as string
- `toSExprString(obj: any, indent?: number): string` - Convert and format in one step

### Symbols

- `TO_SEXPR` - Symbol for custom serialization method
- `SEXPR_TAG` - Symbol to mark S-expression definitions

### Helpers

- `sexpr(tag: string, ...args: any[]): SExprDefinition` - Create S-expression definition
- `smap(obj: Record<string, any>): SExprDefinition` - Create map definition
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
// (map
//   :name "test"
//   :items (list 1 2 3)
//   :meta (map :count 3 :active true))
```

### Custom serialization with nested objects

```typescript
class Node {
  constructor(
    public name: string, 
    public children: Node[] = []
  ) {}
  
  [TO_SEXPR]() {
    return [SEXPR_TAG, 'node', this.name, ...this.children];
  }
}

const tree = new Node('root', [
  new Node('child1'),
  new Node('child2', [new Node('grandchild')])
]);

toSExprString(tree);
// Output:
// (node "root"
//   (node "child1")
//   (node "child2" (node "grandchild")))
```

## License

MIT