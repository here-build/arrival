/**
 * S-Expression Serializer
 * 
 * Provides a systematic way to convert JavaScript objects to s-expressions
 * using Symbol.toSymbolicExpression for custom representations
 */

// Symbols for the protocol
export const TO_SEXPR = Symbol.for('toSymbolicExpression');
export const SEXPR_TAG = Symbol.for('expression');

export type SExpr = string | number | bigint | boolean | null | symbol | SExpr[];
export type SExprDefinition = [typeof SEXPR_TAG, string, ...any[]];

/**
 * Convert any value to an s-expression representation
 */
export function toSExpr(obj: any): SExpr {
  // null/undefined
  if (obj === null) return 'nil';
  if (obj === undefined) return 'undefined';
  
  // Already an s-expression (tagged array)
  if (Array.isArray(obj) && obj[0] === SEXPR_TAG) {
    const [_, tag, ...args] = obj;
    return [tag, ...args.map(toSExpr)];
  }
  
  // Has custom serialization
  if (obj && typeof obj === 'object' && TO_SEXPR in obj) {
    const result = typeof obj[TO_SEXPR] === 'function' ? obj[TO_SEXPR]() : obj[TO_SEXPR];
    if (!Array.isArray(result) || result[0] !== SEXPR_TAG) {
      throw new Error(
        `toSymbolicExpression must return [Symbol.expression, tag, ...args], got: ${JSON.stringify(result)}`
      );
    }
    return toSExpr(result);
  }
  
  // Symbol → :keyword
  if (typeof obj === 'symbol') {
    const name = obj.description || obj.toString().slice(7, -1);
    return `:${name}`;
  }
  
  // Array → (list ...)
  if (Array.isArray(obj)) {
    return ['list', ...obj.map(toSExpr)];
  }
  
  // Plain object → (map :key val ...)
  if (typeof obj === 'object' && obj !== null) {
    const entries: SExpr[] = [];
    for (const [key, value] of Object.entries(obj)) {
      entries.push(`:${key}`, toSExpr(value));
    }
    return ['map', ...entries];
  }
  
  // Primitives (string, number, boolean)
  return obj;
}

/**
 * Format s-expression to string with proper formatting
 */
export function formatSExpr(sexpr: SExpr, indent = 0): string {
  if (Array.isArray(sexpr)) {
    if (sexpr.length === 0) return '()';
    
    const [head, ...tail] = sexpr;
    
    // First element (operator) is never quoted, even if it's a string
    const strHead = typeof head === 'string' && !head.startsWith(':') 
      ? head  // Operators are unquoted
      : formatSExpr(head, 0);
    
    // Special formatting for maps
    if (head === 'map') {
      const spaces = ' '.repeat(indent);
      const pairs: string[] = [];
      
      // Process key-value pairs
      for (let i = 0; i < tail.length; i += 2) {
        if (i + 1 < tail.length) {
          const key = formatSExpr(tail[i], 0);
          const value = formatSExpr(tail[i + 1], 0);
          
          // Check if value needs to be on new line
          const valueItem = tail[i + 1];
          const isComplexValue = Array.isArray(valueItem) || 
            (typeof valueItem === 'string' && valueItem.length > 40);
          
          if (isComplexValue) {
            const formattedValue = formatSExpr(tail[i + 1], indent + 2 + key.length + 1);
            pairs.push(`${key} ${formattedValue}`);
          } else {
            pairs.push(`${key} ${value}`);
          }
        }
      }
      
      // Keep simple maps on one line
      const totalLength = pairs.reduce((sum, p) => sum + p.length, 0) + pairs.length * 2;
      if (pairs.length <= 2 && totalLength < 60) {
        return `(${strHead} ${pairs.join(' ')})`;
      }
      
      // Multi-line for complex maps
      return `(${strHead}\n${pairs.map(p => `${spaces}  ${p}`).join('\n')})`;
    }
    
    // Special formatting for specific operators
    if (head === 'reference' || head === 'definition' || head === 'diagnostic' || 
        head === 'symbol' || head === 'type') {
      // Keep these on one line unless they have very long string values
      const hasLongString = tail.some(item => 
        typeof item === 'string' && item.length > 80 && !item.startsWith(':')
      );
      
      if (!hasLongString) {
        const strTail = tail.map(item => formatSExpr(item, 0)).join(' ');
        return strTail ? `(${strHead} ${strTail})` : `(${strHead})`;
      }
    }
    
    // Check if it's simple enough for one line
    const isSimple = tail.length <= 3 && 
      tail.every(item => !Array.isArray(item) || 
        (Array.isArray(item) && item.length <= 2));
    
    if (isSimple) {
      // Single line for simple expressions
      const strTail = tail.map(item => formatSExpr(item, 0)).join(' ');
      return strTail ? `(${strHead} ${strTail})` : `(${strHead})`;
    } else {
      // Multi-line for complex expressions
      const spaces = ' '.repeat(indent);
      const strTail = tail.map((item, index) => {
        const formatted = formatSExpr(item, indent + 2);
        
        // For lists of structured data, check if we should group key-value pairs
        if (typeof item === 'string' && item.startsWith(':') && index + 1 < tail.length) {
          const nextItem = tail[index + 1];
          const nextFormatted = formatSExpr(nextItem, 0);
          
          // If next item is simple (not an array), keep on same line
          if (!Array.isArray(nextItem) && nextFormatted.length < 40) {
            return null; // Skip this item, it will be handled with the next
          }
        }
        
        // Handle the previous item if it was a key
        if (index > 0 && typeof tail[index - 1] === 'string') {
          const prevItem = tail[index - 1] as string;
          if (prevItem.startsWith(':') && !Array.isArray(item) && formatted.length < 40) {
            return `${spaces}  ${formatSExpr(prevItem, 0)} ${formatted}`;
          }
        }
        
        // If it's a list that starts on same line, don't add extra indent
        if (Array.isArray(item) && formatted.startsWith('(')) {
          return `${spaces}  ${formatted}`;
        }
        
        // Skip if this was handled as part of a key-value pair
        if (formatted === null) return null;
        
        return `${spaces}  ${formatted}`;
      }).filter(line => line !== null).join('\n');
      
      return strTail ? `(${strHead}\n${strTail})` : `(${strHead})`;
    }
  }
  
  // Format primitives
  if (typeof sexpr === 'string') {
    // Keywords (starting with :) don't need quotes
    if (sexpr.startsWith(':')) return sexpr;
    // nil and undefined are special
    if (sexpr === 'nil' || sexpr === 'undefined') return sexpr;
    // All other strings are quoted
    return `"${sexpr.replace(/"/g, '\\"')}"`;
  }
  
  if (typeof sexpr === 'number' || typeof sexpr === 'bigint') {
    return String(sexpr);
  }
  
  if (typeof sexpr === 'boolean') {
    return sexpr ? 'true' : 'false';
  }
  
  if (sexpr === null) {
    return 'nil';
  }
  
  if (typeof sexpr === 'symbol') {
    // Handle Symbol objects (not symbol strings)
    const name = sexpr.description || sexpr.toString().slice(7, -1);
    return `:${name}`;
  }
  
  throw new Error(`Unknown s-expression type: ${typeof sexpr}`);
}

/**
 * Convert to s-expression and format as string
 */
export function toSExprString(obj: any, indent = 0): string {
  const sexpr = toSExpr(obj);
  return formatSExpr(sexpr, indent);
}

/**
 * Helper to create s-expression definitions
 */
export function sexpr(tag: string, ...args: any[]): SExprDefinition {
  return [SEXPR_TAG, tag, ...args];
}

/**
 * Helper to create a map from object
 */
export function smap(obj: Record<string, any>): SExprDefinition {
  return [SEXPR_TAG, 'map', obj];
}

/**
 * Helper to create a list
 */
export function slist(...items: any[]): SExprDefinition {
  return [SEXPR_TAG, 'list', ...items];
}