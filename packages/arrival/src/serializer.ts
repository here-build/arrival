/**
 * S-Expression Serializer
 *
 * Provides a systematic way to convert JavaScript objects to s-expressions
 * using Symbol.toSExpr for custom representations
 */

// @ts-expect-error
// noinspection JSConstantReassignment
Symbol.toSExpr = Symbol.for("toSymbolicExpression");
// @ts-expect-error
// noinspection JSConstantReassignment
Symbol.SExpr = Symbol.for("symbolicExpressionSymbol");

declare global {
  interface SymbolConstructor {
    readonly toSExpr: unique symbol;
    readonly SExpr: unique symbol;
  }

  type SExpr = any;

  interface Object {
    [Symbol.SExpr]?: () => string;
    [Symbol.toSExpr]?: (context: {
      symbol: (value: string) => string | SExprSerializable
      keyword: (value: string) => string | SExprSerializable
      quote: (value: string) => string | SExprSerializable
      expr: (head: string | SExprSerializable, ...args: SExprSerializable[]) => SExprSerializable;
    }) => Array<string | SExprSerializable>;
  }
}

export const SEXPR_TAG = Symbol.for("expression");
export const TO_SEXPR = Symbol.toSExpr;

export type SExprSerializable = string | number | bigint | boolean | null | symbol | SExprSerializable[] | {
  [key: string]: any
};
export type SExpr = string | number | bigint | boolean | null | SExpr[];
export type SExprDefinition = [typeof SEXPR_TAG, string, ...any[]];

// Context object for Symbol.toSExpr implementations
const serializationContext = {
  symbol: (value: string): SExprSerializable => {
    // Return a special marker that won't be quoted
    return { __symbol: value };
  },
  keyword: (value: string): string => `:${value}`,
  quote: (value: string): string => value,
  expr: (head: string | SExprSerializable, ...args: SExprSerializable[]): SExprSerializable => {
    // Return a structure that will be serialized as an expression
    return { __expr: true, head, args };
  },
};

/**
 * Convert any value to an s-expression representation
 */
export function toSExpr(obj: any, visited = new WeakSet()): SExpr {
  // null/undefined
  if (obj === null) return "nil";
  if (obj === undefined) return "undefined";

  // Check for circular references
  if (typeof obj === "object" && obj !== null) {
    if (visited.has(obj)) {
      throw new Error("Circular reference detected");
    }
    visited.add(obj);
  }

  // Handle special marker objects from context helpers
  if (obj && typeof obj === "object") {
    if ("__expr" in obj) {
      // Expression created by context.expr
      const expr = obj as any;
      return [toSExpr(expr.head, visited), ...expr.args.map((arg: any) => toSExpr(arg, visited))];
    }
    if ("__symbol" in obj) {
      // Symbol created by context.symbol - return as unquoted string
      return (obj as any).__symbol;
    }
  }

  // Handle LIPS-specific types before generic Symbol.toSExpr
  if (obj && typeof obj === "object") {
    // LIPS LBigInteger
    if (obj.constructor?.name === "LBigInteger" && "__value__" in obj) {
      const value = obj.__value__;
      // Only use 'n' suffix for numbers that actually need BigInt precision
      // (larger than MAX_SAFE_INTEGER or negative beyond MIN_SAFE_INTEGER)
      if (value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER) {
        return `${value.toString()}n`;
      }
      // For small integers, return as regular number
      return Number(value);
    }
    
    // LIPS LNumber and LFloat (regular numbers, including floats)  
    if ((obj.constructor?.name === "LNumber" || obj.constructor?.name === "LFloat") && "__value__" in obj) {
      return obj.__value__; // Return numeric value directly
    }
    
    // LIPS LSymbol 
    if (obj.constructor?.name === "LSymbol" && "__name__" in obj) {
      return obj.__name__; // Return symbol name as-is (includes : for keywords)
    }
    
    // LIPS LString
    if (obj.constructor?.name === "LString" && "__string__" in obj) {
      const str = obj.__string__;
      // Use template strings for complex strings (multi-line, quotes, etc.)
      if (str.includes('\\n') || str.includes('\\t') || str.includes('"') || str.includes("'")) {
        return `\`${str}\``;
      }
      // Use single quotes for simple strings
      return `'${str}'`;
    }
    
    // LIPS LCharacter  
    if (obj.constructor?.name === "LCharacter" && "__char__" in obj) {
      return `#\\${obj.__char__}`; // Return character with #\ prefix
    }
    
    // LIPS Values (multiple return values)
    if (obj.constructor?.name === "Values" && "__values__" in obj) {
      // Convert to array of values
      return ["values", ...obj.__values__.map((v: any) => toSExpr(v, visited))];
    }
    
    // LIPS Pair (linked list structure)
    if (obj.constructor?.name === "Pair" && "car" in obj && "cdr" in obj) {
      return convertLipsPairToArray(obj, visited);
    }
    
    // LIPS Nil (empty list) - be more specific to avoid catching plain objects
    if (obj.constructor?.name === "Nil") {
      return []; // Return empty list
    }
    
    // LIPS EOF (end of file marker)
    if (obj.constructor?.name === "EOF") {
      return "#<eof>";
    }
    
    // LIPS Macro (macro objects)
    if (obj.constructor?.name === "Macro") {
      return ["macro", obj.name || "<anonymous>"];
    }
    
    // LIPS Syntax (special syntax objects)
    if (obj.constructor?.name === "Syntax") {
      return ["syntax", obj.name || "<syntax>"];
    }
    
    // LIPS Input/Output Ports
    if (obj.constructor?.name === "InputPort" || obj.constructor?.name === "OutputPort") {
      return `#<${obj.constructor.name.toLowerCase()}>`;
    }
  }

  // Has custom serialization with Symbol.toSExpr
  if (obj && typeof obj === "object" && Symbol.toSExpr in obj) {
    const displayName = obj[Symbol.SExpr]?.() ??
      obj.constructor.displayName ??
      obj.displayName ??
      obj.name ??
      obj.constructor.name;
    const contents = obj[Symbol.toSExpr](serializationContext);

    // Convert contents to s-expressions
    const processedContents = contents.map((item: any) => processItem(item, visited));

    return [displayName, ...processedContents];
  }

  // Already an s-expression (tagged array)
  if (Array.isArray(obj) && obj[0] === SEXPR_TAG) {
    const [_, head, ...args] = obj;
    return [toSExpr(head, visited), ...args.map(arg => toSExpr(arg, visited))];
  }

  // Symbol → :keyword
  if (typeof obj === "symbol") {
    const name = obj.description || obj.toString().slice(7, -1);
    return `:${name}`;
  }

  // Array → (list ...)
  if (Array.isArray(obj)) {
    return ["list", ...obj.map(item => toSExpr(item, visited))];
  }

  // Function → skip or placeholder
  if (typeof obj === "function") {
    return "<function>";
  }

  // Date → ISO string
  if (obj instanceof Date) {
    return obj.toISOString();
  }

  // Map → convert to object-like representation
  if (obj instanceof Map) {
    const entries: SExpr[] = [];
    for (const [key, value] of obj) {
      entries.push(`:${String(key)}`, toSExpr(value, visited));
    }
    return ["map", ...entries];
  }

  // Set → convert to list
  if (obj instanceof Set) {
    return ["set", ...Array.from(obj).map(item => toSExpr(item, visited))];
  }

  // Plain object → Scheme-style record with &
  if (typeof obj === "object" && obj !== null) {
    const entries: SExpr[] = [];
    for (const [key, value] of Object.entries(obj)) {
      // Skip functions
      if (typeof value === "function") continue;
      entries.push(`:${key}`, toSExpr(value, visited));
    }
    return ["&", ...entries];
  }

  // Primitives (string, number, boolean)
  return obj;
}

/**
 * Format s-expression to string with proper formatting
 */
export function formatSExpr(sexpr: SExpr, indent = 0): string {
  if (Array.isArray(sexpr)) {
    if (sexpr.length === 0) return "()";

    const [head, ...tail] = sexpr;

    // Special handling for Scheme-style objects with &
    if (head === "&") {
      if (tail.length === 0) return "&()";

      const pairs: string[] = [];
      for (let i = 0; i < tail.length; i += 2) {
        if (i + 1 < tail.length) {
          const key = formatSExpr(tail[i], 0);
          const value = formatSExpr(tail[i + 1], 0);
          pairs.push(`${key} ${value}`);
        }
      }

      return `&(${pairs.join(" ")})`;
    }

    // First element (operator) is never quoted, even if it's a string
    const strHead = typeof head === "string" && !head.startsWith(":")
      ? head  // Operators are unquoted
      : formatSExpr(head, 0);

    // Special formatting for maps
    if (head === "map") {
      const spaces = " ".repeat(indent);
      const pairs: string[] = [];

      // Process key-value pairs
      for (let i = 0; i < tail.length; i += 2) {
        if (i + 1 < tail.length) {
          const key = formatSExpr(tail[i], 0);
          const value = formatSExpr(tail[i + 1], 0);

          // Check if value needs to be on new line
          const valueItem = tail[i + 1];
          const isComplexValue = Array.isArray(valueItem) ||
            (typeof valueItem === "string" && valueItem.length > 40);

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
        return `(${strHead} ${pairs.join(" ")})`;
      }

      // Multi-line for complex maps
      return `(${strHead}\n${pairs.map(p => `${spaces}  ${p}`).join("\n")})`;
    }

    // Special handling for special values
    if (strHead === "<function>") {
      return "<function>";
    }

    // Handle unquoted symbols (from context.symbol)
    if (typeof head === "string" && !head.startsWith(":") && !head.startsWith("\"")) {
      // Check if this looks like a symbol that shouldn't be quoted
      const isSymbol = tail.some(item =>
        typeof item === "string" && !item.startsWith(":") && !item.includes(" "),
      );
      if (isSymbol && (head === "Stateful" || head === "Calculator")) {
        // These are known to use symbols
        const formattedTail = tail.map(item => {
          if (typeof item === "string" && !item.startsWith(":") && !item.includes(" ")) {
            return item; // Don't quote symbols
          }
          return formatSExpr(item, 0);
        }).join(" ");
        return `(${strHead} ${formattedTail})`;
      }
    }

    // Special formatting for specific operators
    if (head === "reference" || head === "definition" || head === "diagnostic" ||
      head === "symbol" || head === "type" || head === "list") {
      // Keep these on one line unless they have very long string values
      const hasLongString = tail.some(item =>
        typeof item === "string" && item.length > 80 && !item.startsWith(":"),
      );

      const hasComplexStructure = tail.some(item =>
        Array.isArray(item) && item.length > 3,
      );

      if (!hasLongString && !hasComplexStructure) {
        const strTail = tail.map(item => formatSExpr(item, 0)).join(" ");
        return strTail ? `(${strHead} ${strTail})` : `(${strHead})`;
      }
    }

    // Check if it's simple enough for one line
    const isSimple = tail.length <= 3 &&
      tail.every(item => !Array.isArray(item) ||
        (Array.isArray(item) && item.length <= 2));

    if (isSimple) {
      // Single line for simple expressions
      const strTail = tail.map(item => formatSExpr(item, 0)).join(" ");
      return strTail ? `(${strHead} ${strTail})` : `(${strHead})`;
    } else {
      // Multi-line for complex expressions
      const spaces = " ".repeat(indent);
      const strTail = tail.map((item, index) => {
        const formatted = formatSExpr(item, indent + 2);

        // For lists of structured data, check if we should group key-value pairs
        if (typeof item === "string" && item.startsWith(":") && index + 1 < tail.length) {
          const nextItem = tail[index + 1];
          const nextFormatted = formatSExpr(nextItem, 0);

          // If next item is simple (not an array), keep on same line
          if (!Array.isArray(nextItem) && nextFormatted.length < 40) {
            return null; // Skip this item, it will be handled with the next
          }
        }

        // Handle the previous item if it was a key
        if (index > 0 && typeof tail[index - 1] === "string") {
          const prevItem = tail[index - 1] as string;
          if (prevItem.startsWith(":") && !Array.isArray(item) && formatted.length < 40) {
            return `${spaces}  ${formatSExpr(prevItem, 0)} ${formatted}`;
          }
        }

        // If it's a list that starts on same line, don't add extra indent
        if (Array.isArray(item) && formatted.startsWith("(")) {
          return `${spaces}  ${formatted}`;
        }

        // Skip if this was handled as part of a key-value pair
        if (formatted === null) return null;

        return `${spaces}  ${formatted}`;
      }).filter(line => line !== null).join("\n");

      return strTail ? `(${strHead}\n${strTail})` : `(${strHead})`;
    }
  }

  // Format primitives
  if (typeof sexpr === "string") {
    // Keywords (starting with :) don't need quotes
    if (sexpr.startsWith(":")) return sexpr;
    // nil and undefined are special
    if (sexpr === "nil" || sexpr === "undefined") return sexpr;
    // Special values
    if (sexpr === "<function>") return sexpr;
    // BigInt notation (ends with n) - don't quote
    if (sexpr.endsWith("n") && /^\d+n$/.test(sexpr)) return sexpr;
    // Template strings (wrapped in backticks) - don't quote
    if (sexpr.startsWith("`") && sexpr.endsWith("`")) return sexpr;
    // Single-quoted strings - don't quote (already quoted)
    if (sexpr.startsWith("'") && sexpr.endsWith("'")) return sexpr;
    // Character literals (start with #\) - don't quote
    if (sexpr.startsWith("#\\")) return sexpr;
    // Bare symbols (no quotes, no special chars) - don't quote
    if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(sexpr)) return sexpr;
    // All other strings are quoted
    return `"${sexpr.replace(/"/g, "\\\"")}"`;
  }

  if (typeof sexpr === "number" || typeof sexpr === "bigint") {
    return String(sexpr);
  }

  if (typeof sexpr === "boolean") {
    return sexpr ? "true" : "false";
  }

  if (sexpr === null) {
    return "nil";
  }

  throw new Error(`Unknown s-expression type: ${typeof sexpr}`);
}

// Convert LIPS Pair linked list to JavaScript array
function convertLipsPairToArray(pair: any, visited: WeakSet<object>): SExpr {
  const result: any[] = [];
  let current = pair;
  
  while (current && current.constructor?.name === "Pair") {
    // Add car (current element) to result
    result.push(toSExpr(current.car, visited));
    
    // Move to cdr (next element)
    current = current.cdr;
    
    // Handle circular references
    if (current && typeof current === "object" && visited.has(current)) {
      throw new Error("Circular reference in LIPS Pair");
    }
  }
  
  // If cdr is not null/empty, it's an improper list (rare in practice)
  if (current && current.constructor?.name !== "Nil" && !(current.constructor?.name === "Object" && Object.keys(current).length === 0)) {
    // This would be a dotted pair notation in Scheme, but we'll just add it to the array
    result.push(toSExpr(current, visited));
  }
  
  return result;
}

// Helper to process items from Symbol.toSExpr
function processItem(item: any, visited: WeakSet<object>): SExpr {
  // Handle special serializable values from context helpers
  if (item && typeof item === "object" && "__expr" in item) {
    // Expression created by context.expr
    const expr = item as any;
    return [toSExpr(expr.head, visited), ...expr.args.map((arg: any) => toSExpr(arg, visited))];
  }
  if (item && typeof item === "object" && "__symbol" in item) {
    // Symbol created by context.symbol - return as unquoted string
    return (item as any).__symbol;
  }
  if (Array.isArray(item) && item[0] === SEXPR_TAG) {
    const [_, head, ...args] = item;
    return toSExpr([head, ...args], visited);
  }
  return toSExpr(item, visited);
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
  return [SEXPR_TAG, "&", ...Object.entries(obj).flatMap(([k, v]) => [`:${k}`, v])];
}

/**
 * Helper to create a list
 */
export function slist(...items: any[]): SExprDefinition {
  return [SEXPR_TAG, "list", ...items];
}
