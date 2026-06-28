// The value → string PRINT protocol. Each AValue answers `["arrival/print"](): string` with its
// own repr, recursing on children through `printValue` — so there is no central type-switch and no
// drift (this replaces both printer.ts's get_instances map AND APair.ts's local stringifyValue).
//
// This module is a LEAF: it holds only the dispatch plus the NON-AValue residual — raw JS functions
// (a lambda/native), raw JS bottoms, and foreign objects — the three things that aren't boxed Scheme
// values and therefore can't carry a print method. It imports nothing class-specific, so any value
// class can import `printValue` for its child recursion without a cycle.
import { LAMBDA } from "../well-known-symbols.js";

interface Printable {
  "arrival/print"(): string;
}

function isPrintable(v: unknown): v is Printable {
  return v != null && typeof (v as Record<string, unknown>)["arrival/print"] === "function";
}

/**
 * Render any value to its Scheme repr. An AValue answers via its own `["arrival/print"]()`; a
 * non-AValue (raw function / bottom / foreign object) falls through to `printForeign`.
 */
export function printValue(value: unknown): string {
  if (isPrintable(value)) return value["arrival/print"]();
  return printForeign(value);
}

// The non-AValue residual. Raw JS bottoms are largely moot post-membrane-materialization (booleans
// box to ABool, etc.) but kept defensive; a raw JS function (a lambda/native) renders as a procedure;
// a foreign object defers to its own toString, else a `#<ctor.name>` tag.
function printForeign(value: unknown): string {
  if (value === true) return "#t";
  if (value === false) return "#f";
  if (value === null) return "#null";
  if (value === undefined) return "#void";
  if (typeof value === "function") return functionRepr(value);
  if (typeof value === "object") {
    const o = value as { toString?: () => unknown; constructor?: { name?: string } };
    if (typeof o.toString === "function" && o.toString !== Object.prototype.toString) {
      return String(o.toString());
    }
    return o.constructor?.name ? `#<${o.constructor.name}>` : "#<Object>";
  }
  return String(value);
}

// A raw JS procedure (a Scheme lambda carries the LAMBDA brand; a native is a bare function). The
// old `#<procedure(native)>` split rode on the fragile, half-dead `is_native_function` heuristic and
// is dropped — every procedure is `#<procedure:name>` or `#<procedure>`.
function functionRepr(fn: object): string {
  const f = fn as { __name__?: string | symbol; name?: string };
  if (f.__name__ != null) {
    const name =
      typeof f.__name__ === "symbol"
        ? f.__name__.toString().replace(/^Symbol\((?:#:)?([^)]+)\)$/, "$1")
        : f.__name__;
    return `#<procedure:${name}>`;
  }
  if (f.name && !(LAMBDA in fn)) {
    return `#<procedure:${f.name.trim()}>`;
  }
  return "#<procedure>";
}
