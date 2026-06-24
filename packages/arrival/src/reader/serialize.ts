import { is_undef } from "../eval/guards.js";
import { AString } from "../values/primitives/AString.js";
import { ASymbol } from "../values/primitives/ASymbol.js";
import { AExact, AInexact } from "../values/numbers.js";
import { APair } from "../values/primitives/APair.js";
import { nil } from "../values/primitives/ANil.js";
import { ACharacter } from "../values/primitives/ACharacter.js";

export function parseBigInt(str: string, radix: number = 10): bigint {
  str = str.trim();
  const negative = str.startsWith("-");
  if (negative || str.startsWith("+")) {
    str = str.slice(1);
  }
  let result = 0n;
  const base = BigInt(radix);
  for (const char of str.toLowerCase()) {
    const digit = Number.parseInt(char, radix);
    TypeError.invariant(!Number.isNaN(digit), `Invalid digit '${char}' for radix ${radix}`);
    result = result * base + BigInt(digit);
  }
  return negative ? -result : result;
}

// ── Deserialization revivers, keyed by class tag ──
// SchemeString/SchemeCharacter are reached through getters so the live binding is read lazily —
// referencing them eagerly here would form a module-init cycle with the types modules.
const serialization_map = {
  pair: ([car, cdr]) => new APair(car, cdr),
  number(value) {
    if (AString.isString(value)) {
      return new AExact(parseBigInt(value.valueOf(), 10));
    }
    if (typeof value === "bigint") {
      return new AExact(value);
    }
    if (typeof value === "number") {
      // Safe-integer JS numbers round-trip exactly as bigint; anything else stays inexact float.
      return Number.isSafeInteger(value) ? new AExact(BigInt(value)) : new AInexact(value);
    }
    return value; // already a wrapped number
  },
  regex([pattern, flag]) {
    return new RegExp(pattern, flag);
  },
  nil() {
    return nil;
  },
  symbol(value) {
    if (AString.isString(value)) {
      return new ASymbol(value);
    } else if (Array.isArray(value)) {
      return new ASymbol(Symbol.for(value[0]));
    }
  },
  get string() {
    return AString;
  },
  get character() {
    return ACharacter;
  },
};
// Serialized tags are the class's INDEX into this array, not its name — a small-integer `@` keeps the
// JSON compact. Index assignment is therefore positional: never reorder `serialization_map`.
export const available_class = Object.keys(serialization_map);
export const class_map = {};

function resolve_name(i) {
  return available_class[i];
}

// Revives the compact form: `{"@": classIndex, "#": payload}` → the corresponding Scheme value.
export function unserialize(string) {
  return JSON.parse(string, (_, object) => {
    if (object && typeof object === "object" && !is_undef(object["@"])) {
      const cls = resolve_name(object["@"]);
      if (serialization_map[cls]) {
        return serialization_map[cls](object["#"]);
      }
    }
    return object;
  });
}
