/**
 * @dappsnap/s-expressions
 *
 * A clean, abstract S-expression serialization library with custom protocol support.
 *
 * Features:
 * - Convert JavaScript objects to S-expressions
 * - Support for custom serialization via Symbol.toSymbolicExpression
 * - Proper formatting with indentation
 * - Type-safe with TypeScript
 *
 * Basic usage:
 * ```typescript
 * import { toSExpr, formatSExpr, TO_SEXPR, SEXPR_TAG, sexpr } from '@dappsnap/s-expressions';
 *
 * // Simple conversion
 * const expr = toSExpr({ name: "test", value: 42 });
 * console.log(formatSExpr(expr));
 * // Output: (map :name "test" :value 42)
 *
 * // Custom serialization
 * class MyClass {
 *   [TO_SEXPR]() {
 *     return [SEXPR_TAG, 'my-class', this.data];
 *   }
 * }
 * ```
 */

export {
  // Core functions
  toSExpr,
  formatSExpr,
  toSExprString,

  SEXPR_TAG,
  TO_SEXPR,

  // Helpers
  sexpr,
  smap,
  slist,

  // Types
  type SExpr,
  type SExprDefinition,
} from './serializer';

// Re-export everything for convenience
export * from './serializer';
