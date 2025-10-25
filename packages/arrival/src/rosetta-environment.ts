/**
 * Rosetta Environment Extension
 *
 * Extends LIPS Environment with automatic LIPS ↔ JS conversion for seamless interop.
 * Provides Environment.defineRosetta() for declarative function wrapping.
 */

import { Environment, env as lipsGlobalEnv } from './lips/lips';
import { sandboxedEnv } from './enhanced-environment';

export interface RosettaFunction {
  fn: Function;
  options?: {
    preserveLipsNumbers?: boolean; // Keep LBigInteger vs convert to JS numbers
    memoize?: boolean;            // Cache conversion results
  };
}

/**
 * Convert LIPS data to JavaScript data
 */
export function lipsToJs(value: any): any {
  // Handle null/undefined
  if (value == null) return value;

  // Handle LIPS numbers (LBigInteger, LFloat, etc.)
  if (value && typeof value === 'object' && value.__value__ !== undefined) {
    const val = value.__value__;
    // Convert bigints to numbers for JS compatibility
    return typeof val === 'bigint' ? Number(val) : val;
  }

  // Handle LIPS strings (LString)
  if (value && typeof value === 'object' && value.__string__ !== undefined) {
    return value.__string__;
  }

  // Handle LIPS Nil (empty list)
  const nil = sandboxedEnv.get('nil', { throwError: false });
  if (nil && value === nil) {
    return [];
  }

  // Handle LIPS Pair (list) - convert to JS array
  if (value && typeof value === 'object' && 'car' in value && 'cdr' in value) {
    const result = [];
    let current = value;

    while (current && current !== nil && current.car !== undefined) {
      result.push(lipsToJs(current.car)); // Recursive conversion
      current = current.cdr;
    }
    return result;
  }

  // Handle JS arrays (convert elements recursively)
  if (Array.isArray(value)) {
    return value.map(lipsToJs);
  }

  // Handle JS objects (convert values recursively)
  if (value && typeof value === 'object' && value.constructor === Object) {
    const result: any = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = lipsToJs(val);
    }
    return result;
  }

  // Return primitives as-is
  return value;
}

/**
 * Convert JavaScript data to LIPS data
 */
export function jsToLips(value: any): any {
  // Handle null/undefined
  if (value == null) {
    const nil = sandboxedEnv.get('nil', { throwError: false });
    return nil || null;
  }

  // Handle JS arrays - convert to LIPS list
  if (Array.isArray(value)) {
    const cons = sandboxedEnv.get('cons', { throwError: false });
    const nil = sandboxedEnv.get('nil', { throwError: false });

    if (!cons || !nil) {
      console.warn('cons or nil not available, returning JS array');
      return value;
    }

    // Build LIPS list from right to left
    let result = nil;
    for (let i = value.length - 1; i >= 0; i--) {
      result = cons(jsToLips(value[i]), result); // Recursive conversion
    }
    return result;
  }

  // Handle JS objects (convert values recursively)
  if (value && typeof value === 'object' && value.constructor === Object) {
    const result: any = {};
    for (const [key, val] of Object.entries(value)) {
      result[key] = jsToLips(val);
    }
    return result;
  }

  // Return primitives as-is (numbers, strings, booleans)
  return value;
}

/**
 * Create a Rosetta wrapper that handles automatic conversion
 */
export function createRosettaWrapper(config: RosettaFunction): Function {
  const { fn, options = {} } = config;

  return function rosettaWrapper(...args: any[]) {
    // Convert LIPS arguments to JS
    const jsArgs = args.map(arg => lipsToJs(arg));

    console.log('Rosetta call:', {
      originalArgs: args.length,
      convertedArgs: jsArgs.length
    });

    // Execute the JS function
    let result;
    try {
      result = fn(...jsArgs);
    } catch (error) {
      console.error('Rosetta function error:', error);
      throw error;
    }

    // Convert result back to LIPS
    const lipsResult = jsToLips(result);

    console.log('Rosetta result:', {
      jsResult: typeof result,
      lipsResult: lipsResult?.constructor?.name || typeof lipsResult
    });

    return lipsResult;
  };
}

/**
 * Extend Environment prototype with defineRosetta method
 */
declare module './lips/lips' {
  interface Environment {
    defineRosetta(name: string, config: RosettaFunction): void;
  }
}

// Add defineRosetta method to Environment prototype
(Environment.prototype as any).defineRosetta = function(name: string, config: RosettaFunction): void {
  const wrapper = createRosettaWrapper(config);
  this.set(name, wrapper);

  console.log(`Rosetta function '${name}' defined in environment`);
};

export { Environment };
