// Faithful generic harvest signatures for HOF sequence ops (map/filter/reduce/…).
//
// Prelude: `declare const name: SIG`. Multi-call-signature object types carry
// List + vector overloads (carriers dialect). Scheme arg order is preserved
// (fn/pred first; collection last for tagless; map is fn + one-or-more sequences).

/** map — R7RS/srfi: (map f xs) / (map f xs ys …); single-seq is list|vector polymorphic. */
export const MAP_HOF =
  "{" +
  "<T, B>(f: (x: T) => B, xs: List<T>): List<B>; " +
  "<T, B>(f: (x: T) => B, xs: readonly T[]): readonly B[]; " +
  "<A, B, R>(f: (a: A, b: B) => R, as: List<A>, bs: List<B>): List<R>; " +
  "<A, B, R>(f: (a: A, b: B) => R, as: readonly A[], bs: readonly B[]): readonly R[]; " +
  "<A, B, C, R>(f: (a: A, b: B, c: C) => R, as: List<A>, bs: List<B>, cs: List<C>): List<R>; " +
  "<A, B, C, R>(f: (a: A, b: B, c: C) => R, as: readonly A[], bs: readonly B[], cs: readonly C[]): readonly R[]" +
  "}";

/** for-each — list-only in R7RS pack; void. */
export const FOR_EACH_HOF =
  "{" +
  "<T>(f: (x: T) => unknown, xs: List<T>): void; " +
  "<A, B>(f: (a: A, b: B) => unknown, as: List<A>, bs: List<B>): void; " +
  "<A, B, C>(f: (a: A, b: B, c: C) => unknown, as: List<A>, bs: List<B>, cs: List<C>): void" +
  "}";

/** filter — pred first, seq second; list|vector polymorphic; type-guard overload keeps S. */
export const FILTER_HOF =
  "{" +
  "<T, S extends T>(p: (x: T) => x is S, xs: List<T>): List<S>; " +
  "<T>(p: (x: T) => unknown, xs: List<T>): List<T>; " +
  "<T, S extends T>(p: (x: T) => x is S, xs: readonly T[]): readonly S[]; " +
  "<T>(p: (x: T) => unknown, xs: readonly T[]): readonly T[]" +
  "}";

/**
 * reduce — arrival/SRFI surface (reduce f ridentity xs); f(element, acc).
 * Tagless receiver is xs (last).
 */
export const REDUCE_HOF =
  "{" +
  "<T, A>(f: (element: T, acc: A) => A, ridentity: A, xs: List<T>): A; " +
  "<T, A>(f: (element: T, acc: A) => A, ridentity: A, xs: readonly T[]): A" +
  "}";

/** fold-right — (fold-right f knil xs); f(x, acc). List-only live body. */
export const FOLD_RIGHT_HOF =
  "{ <T, A>(f: (x: T, acc: A) => A, knil: A, xs: List<T>): A }";

/** take-while / drop-while — (op pred xs); same-kind result. */
export const TAKE_WHILE_HOF =
  "{" +
  "<T>(p: (x: T) => unknown, xs: List<T>): List<T>; " +
  "<T>(p: (x: T) => unknown, xs: readonly T[]): readonly T[]" +
  "}";

/** find — (find pred list); miss → null (nil). Type-guard keeps S. */
export const FIND_HOF =
  "{" +
  "<T, S extends T>(p: (x: T) => x is S, xs: List<T>): S | null; " +
  "<T>(p: (x: T) => unknown, xs: List<T>): T | null" +
  "}";

/** vector-map — proc first, one-or-more vectors. */
export const VECTOR_MAP_HOF =
  "{" +
  "<T, B>(f: (x: T) => B, v: readonly T[]): readonly B[]; " +
  "<A, B, R>(f: (a: A, b: B) => R, a: readonly A[], b: readonly B[]): readonly R[]; " +
  "<A, B, C, R>(f: (a: A, b: B, c: C) => R, a: readonly A[], b: readonly B[], c: readonly C[]): readonly R[]" +
  "}";

/** vector-for-each — void. */
export const VECTOR_FOR_EACH_HOF =
  "{" +
  "<T>(f: (x: T) => unknown, v: readonly T[]): void; " +
  "<A, B>(f: (a: A, b: B) => unknown, a: readonly A[], b: readonly B[]): void; " +
  "<A, B, C>(f: (a: A, b: B, c: C) => unknown, a: readonly A[], b: readonly B[], c: readonly C[]): void" +
  "}";

/** string-map — chars as string; result string. */
export const STRING_MAP_HOF =
  "{" +
  "(f: (c: string) => string, s: string): string; " +
  "(f: (...chars: string[]) => string, ...strings: string[]): string" +
  "}";

/** string-for-each — void. */
export const STRING_FOR_EACH_HOF =
  "{" +
  "(f: (c: string) => unknown, s: string): void; " +
  "(f: (...chars: string[]) => unknown, ...strings: string[]): void" +
  "}";
