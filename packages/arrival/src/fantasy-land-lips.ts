/**
 * Fantasy Land Monkey-Patching for LIPS Classes
 *
 * Makes LIPS data structures (Pair, LString, etc.) Fantasy Land compatible
 * so Ramda functions work seamlessly with LIPS classes.
 *
 * Implements Fantasy Land protocols:
 * - Functor (map)
 * - Filterable (filter)
 * - Foldable (reduce)
 * - Traversable (traverse)
 */

import { env as lipsGlobalEnv } from './lips/lips';

// Import LIPS classes for instanceof checks
// Note: These are constructor functions defined in lips.ts
let Pair: any, Nil: any, LString: any;

// Initialize LIPS classes from the global environment
function initializeLipsClasses() {
  try {
    // Get constructors by creating instances and checking their constructors
    const cons = lipsGlobalEnv.get('cons', { throwError: false });
    const listFn = lipsGlobalEnv.get('list', { throwError: false });

    if (cons) {
      const testPair = cons(1, null);
      Pair = testPair.constructor;
    }

    if (listFn) {
      const testNil = listFn();
      Nil = testNil.constructor;
    }

    console.log('🔧 LIPS classes initialized:', {
      Pair: Pair?.name,
      Nil: Nil?.name
    });
  } catch (error) {
    console.warn('⚠️ Could not initialize LIPS classes:', error);
  }
}

// Fantasy Land method names
const FL = {
  map: 'fantasy-land/map',
  filter: 'fantasy-land/filter',
  reduce: 'fantasy-land/reduce',
  traverse: 'fantasy-land/traverse',
  of: 'fantasy-land/of',
  ap: 'fantasy-land/ap',
  chain: 'fantasy-land/chain',
  concat: 'fantasy-land/concat'
};

/**
 * Apply Fantasy Land monkey-patches to LIPS classes
 */
export function applyFantasyLandPatches(): void {
  console.log("🧙‍♂️ Applying Fantasy Land monkey-patches to LIPS classes...");

  // Initialize LIPS classes first
  initializeLipsClasses();

  if (Pair) {
    patchPairClass(Pair);
    console.log("✨ Pair class patched with Fantasy Land protocols");
  }

  if (Nil) {
    console.log("✨ Nil class available for instanceof checks");
  }

  // TODO: Add LString support later if needed
}

// Note: Old helper functions removed - we now use initializeLipsClasses() and instanceof checks

/**
 * Patch Pair class with Fantasy Land protocols
 */
function patchPairClass(PairClass: any): void {
  const proto = PairClass.prototype;

  // Functor: map
  proto[FL.map] = function(f: Function) {
    return mapPair(f, this);
  };

  // Filterable: filter
  proto[FL.filter] = function(predicate: Function) {
    return filterPair(predicate, this);
  };

  // Foldable: reduce
  proto[FL.reduce] = function(f: Function, initial: any) {
    return reducePair(f, initial, this);
  };

  // Traversable: traverse
  proto[FL.traverse] = function(of: Function, f: Function) {
    return traversePair(of, f, this);
  };

  // Add static of method (Applicative)
  PairClass[FL.of] = function(value: any) {
    const cons = lipsGlobalEnv.get('cons', { throwError: false });
    const listFn = lipsGlobalEnv.get('list', { throwError: false });
    const nil = listFn ? listFn() : null; // Get Nil by calling list()
    return cons ? cons(value, nil) : null;
  };

  // Chain (Monad)
  proto[FL.chain] = function(f: Function) {
    return chainPair(f, this);
  };
}

/**
 * Patch LString class with Fantasy Land protocols
 */
function patchLStringClass(LStringClass: any): void {
  const proto = LStringClass.prototype;

  // Functor: map over characters
  proto[FL.map] = function(f: Function) {
    const str = this.valueOf();
    const chars = str.split('').map(f).join('');
    return new LStringClass(chars);
  };

  // Add static of method
  LStringClass[FL.of] = function(value: any) {
    return new LStringClass(String(value));
  };
}

/**
 * Map over a LIPS Pair (list)
 */
function mapPair(f: Function, pair: any): any {
  const cons = lipsGlobalEnv.get('cons', { throwError: false });
  const listFn = lipsGlobalEnv.get('list', { throwError: false });
  const nil = listFn ? listFn() : null;

  // Use instanceof for reliable type checking
  if (!pair || (Nil && pair instanceof Nil)) return nil;

  const mappedCar = f(pair.car);
  const mappedCdr = mapPair(f, pair.cdr);

  return cons ? cons(mappedCar, mappedCdr) : null;
}

/**
 * Filter a LIPS Pair (list)
 */
function filterPair(predicate: Function, pair: any): any {
  const cons = lipsGlobalEnv.get('cons', { throwError: false });
  const listFn = lipsGlobalEnv.get('list', { throwError: false });
  const nil = listFn ? listFn() : null;

  // Use instanceof for reliable type checking
  if (!pair || (Nil && pair instanceof Nil)) return nil;

  const restFiltered = filterPair(predicate, pair.cdr);

  if (predicate(pair.car)) {
    return cons ? cons(pair.car, restFiltered) : null;
  } else {
    return restFiltered;
  }
}

/**
 * Reduce a LIPS Pair (list)
 */
function reducePair(f: Function, initial: any, pair: any): any {
  const listFn = lipsGlobalEnv.get('list', { throwError: false });
  const nil = listFn ? listFn() : null;

  // Use instanceof for reliable type checking
  if (!pair || (Nil && pair instanceof Nil)) return initial;

  const accumulated = f(initial, pair.car);
  return reducePair(f, accumulated, pair.cdr);
}

/**
 * Traverse a LIPS Pair (list)
 */
function traversePair(of: Function, f: Function, pair: any): any {
  const cons = lipsGlobalEnv.get('cons', { throwError: false });
  const listFn = lipsGlobalEnv.get('list', { throwError: false });
  const nil = listFn ? listFn() : null;

  // Use instanceof for reliable type checking
  if (!pair || (Nil && pair instanceof Nil)) return of(nil);

  // This is a simplified traverse - full implementation would need ap
  const mappedCar = f(pair.car);
  const mappedCdr = traversePair(of, f, pair.cdr);

  // Assuming the mapped values have ap method for Applicative
  if (mappedCar && mappedCar[FL.ap]) {
    return mappedCar[FL.ap](mappedCdr);
  }

  return of(cons ? cons(mappedCar, mappedCdr) : null);
}

/**
 * Chain (flatMap) for LIPS Pair
 */
function chainPair(f: Function, pair: any): any {
  const concat = lipsGlobalEnv.get('append', { throwError: false });
  const listFn = lipsGlobalEnv.get('list', { throwError: false });
  const nil = listFn ? listFn() : null;

  // Use instanceof for reliable type checking
  if (!pair || (Nil && pair instanceof Nil)) return nil;

  const mapped = f(pair.car);
  const chained = chainPair(f, pair.cdr);

  return concat ? concat(mapped, chained) : mapped;
}
