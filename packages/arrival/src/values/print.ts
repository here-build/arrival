// The value → string PRINT protocol. Each AValue answers `["arrival/print"](): string` with its
// own repr, recursing on children through `printValue` — so there is no central type-switch and no
// drift.
//
// This module is a LEAF: it holds only the dispatch plus the NON-AValue residual — raw JS functions
// (the quarantined `env.defineRosetta` legacy authoring arm's bare-fn output — a real scheme
// lambda is an ALambda now, answering `arrival/print` directly, reverse-membrane-for-callables.md
// §3 step 1), raw JS bottoms, and foreign objects — things that aren't boxed Scheme values and
// therefore can't carry a print method. It imports nothing class-specific, so any value class can
// import `printValue` for its child recursion without a cycle.

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

// A raw JS procedure reaching here is the quarantined `env.defineRosetta` legacy authoring
// arm's bare-fn output — every scheme-authored lambda is an ALambda now, answering
// `arrival/print` directly (isPrintable catches it before this fn ever runs). Renders as
// `#<procedure:name>` or `#<procedure>`.
function functionRepr(fn: object): string {
  const f = fn as { __name__?: string | symbol; name?: string };
  if (f.__name__ != null) {
    const name =
      typeof f.__name__ === "symbol" ? f.__name__.toString().replace(/^Symbol\((?:#:)?([^)]+)\)$/, "$1") : f.__name__;
    return `#<procedure:${name}>`;
  }
  if (f.name) {
    return `#<procedure:${f.name.trim()}>`;
  }
  return "#<procedure>";
}
