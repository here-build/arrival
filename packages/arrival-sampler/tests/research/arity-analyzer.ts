// arity-analyzer.ts — the OBSERVE-ONLY side-analyzer for "wrong args" mispredictions.
//
// The arrival oracle enforces STRUCTURAL + Σ (bound-symbol), but has NO arity/type awareness
// (Layer T is stubbed: signatureOf → null). So a model that supplies the wrong NUMBER of arguments to
// a tool — or a coarsely wrong-typed literal — is NOT masked; the program stays structurally/Σ valid.
// To still MEASURE those mispredictions we run this analyzer alongside the constrained decoder. It
// never masks; it only watches each step's preferred token and judges it against the tool's declared
// arity (read from the registry, NOT from `__rosettaTypes__`, which the apple-intents grant env leaves
// empty). Per V's scope call: ARITY is the clean signal; coarse TYPE is best-effort, checked only for
// completed LITERAL args at the moment the call closes (so it fires at most once per call, no
// double-count, no false positives on contacts/datetimes/subforms).

import { APPLE_INTENTS, type ParamType, type ToolSpec } from "../../src/runners/fixtures/apple-intents/registry.js";

/** The coarse literal kinds we can read off a partial s-expr without evaluating it. */
export type CoarseType = "string" | "number" | "boolean";

/** What the analyzer concluded about the model's preferred token at an argument boundary. */
export interface ArityVerdict {
  readonly headSymbol: string;
  readonly declaredArity: number;
  readonly currentArgCount: number;
  readonly kind: "ok" | "too-few-close" | "overfull-open" | "type-coarse-mismatch";
  /** The model's preferred token string that triggered this verdict. */
  readonly preferStr: string;
}

interface ArityEntry {
  readonly arity: number;
  /** Coarse expected type per slot (`null` ⇒ not coarse-checkable: contact/enum/app/list/datetime). */
  readonly types: readonly (CoarseType | null)[];
}

export type ArityTable = ReadonlyMap<string, ArityEntry>;

/** Map an arrival param type to the coarse literal kind we can verify, or `null` to skip. `contact`,
 *  `enum`, `app`, `list`, `datetime` are deliberately skipped — a literal `"Mom"` in a contact slot is
 *  correct, and a datetime may be a string or number; flagging them would be false positives. */
function expectedCoarse(t: ParamType): CoarseType | null {
  if (t === "string") return "string";
  if (t === "number") return "number";
  if (t === "boolean") return "boolean";
  return null;
}

/** Build the arity/type table once from the tool registry. */
export function buildArityTable(tools: readonly ToolSpec[] = APPLE_INTENTS): ArityTable {
  const table = new Map<string, ArityEntry>();
  for (const tool of tools) {
    table.set(tool.name, {
      arity: tool.params.length,
      types: tool.params.map((pp) => expectedCoarse(pp.type)),
    });
  }
  return table;
}

/** Build an arity table from plain `{ name, arity }` entries (no coarse-type info — type slots are all
 *  `null`, i.e. arity-only). For surfaces like sift whose tools carry an arity but not apple-style
 *  typed params. */
export function arityTableFrom(entries: readonly { name: string; arity: number }[]): ArityTable {
  const table = new Map<string, ArityEntry>();
  for (const e of entries) {
    table.set(e.name, { arity: e.arity, types: Array.from({ length: e.arity }, () => null) });
  }
  return table;
}

/** The coarse literal kind of a completed atom, or `null` when it's a symbol / not a simple literal. */
function literalCoarse(atom: string): CoarseType | null {
  if (atom.startsWith('"')) return "string";
  if (atom === "#t" || atom === "#f") return "boolean";
  if (/^[+-]?\.?\d/.test(atom)) return "number";
  return null;
}

const OPEN = new Set(["(", "[", "{"]);
const CLOSE = new Set([")", "]", "}"]);

interface Frame {
  head: string | null;
  headComplete: boolean;
  argCount: number;
  /** Coarse type per arg slot (`null` for a non-literal arg / subform). */
  argCoarse: (CoarseType | null)[];
}

interface ParseResult {
  /** The innermost (currently-open) application frame, or `null` at top level. */
  frame: Frame | null;
  /** The cursor is mid-atom (an atom is being typed) — not a clean argument boundary. */
  midAtom: boolean;
}

/**
 * Walk an accepted prefix and recover the innermost open application frame + whether the cursor sits
 * mid-atom. String-aware (a `)` inside `"…"` does not close). O(len(prefix)); prefixes are short.
 */
function parsePrefix(prefix: string): ParseResult {
  const stack: Frame[] = [];
  let buf = "";
  let inStr = false;
  let esc = false;

  const emitAtom = (atom: string): void => {
    const top = stack.at(-1);
    if (!top) return; // top-level atom — no enclosing call.
    if (top.headComplete) {
      top.argCount++;
      top.argCoarse.push(literalCoarse(atom));
    } else {
      top.head = atom;
      top.headComplete = true;
    }
  };
  const flush = (): void => {
    if (buf !== "") {
      emitAtom(buf);
      buf = "";
    }
  };

  for (const element of prefix) {
    const ch = element;
    if (inStr) {
      buf += ch;
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') {
      flush();
      buf = '"';
      inStr = true;
      continue;
    }
    if (/\s/.test(ch)) {
      flush();
      continue;
    }
    if (OPEN.has(ch)) {
      flush();
      stack.push({ head: null, headComplete: false, argCount: 0, argCoarse: [] });
      continue;
    }
    if (CLOSE.has(ch)) {
      flush();
      stack.pop(); // the just-closed subform...
      const parent = stack.at(-1);
      if (parent) {
        // ...counts as ONE (non-literal) argument to its enclosing call.
        if (parent.headComplete) {
          parent.argCount++;
          parent.argCoarse.push(null);
        } else {
          parent.headComplete = true;
        }
      }
      continue;
    }
    buf += ch;
  }

  return { frame: stack.at(-1) ?? null, midAtom: buf !== "" || inStr };
}

export interface ArityAnalyzer {
  /** Observe one decode step. Returns a verdict iff the cursor sits at a clean argument boundary of a
   *  KNOWN tool head; `null` otherwise (mid-atom, unknown/arithmetic head, top level). */
  observe(prefix: string, prefer: string): ArityVerdict | null;
}

export function makeArityAnalyzer(table: ArityTable = buildArityTable()): ArityAnalyzer {
  return {
    observe(prefix: string, prefer: string): ArityVerdict | null {
      const { frame, midAtom } = parsePrefix(prefix);
      if (!frame || !frame.headComplete || frame.head === null || midAtom) return null;
      const entry = table.get(frame.head);
      if (!entry) return null; // arithmetic / unknown head — not a tool, not attributed.

      const head = frame.head;
      const declaredArity = entry.arity;
      const currentArgCount = frame.argCount;
      const base = { headSymbol: head, declaredArity, currentArgCount, preferStr: prefer };

      const trimmed = prefer.replace(/^\s+/, "");
      const first = trimmed[0] ?? "";

      // Whitespace-only / empty (EOS) preferred token ⇒ no arity decision.
      if (trimmed === "") return null;

      if (CLOSE.has(first)) {
        if (currentArgCount < declaredArity) return { ...base, kind: "too-few-close" };
        // Arity satisfied at close — best-effort coarse type scan of completed literal args (once).
        for (let slot = 0; slot < Math.min(declaredArity, frame.argCoarse.length); slot++) {
          const expected = entry.types[slot] ?? null;
          const actual = frame.argCoarse[slot] ?? null;
          if (expected !== null && actual !== null && expected !== actual) {
            return { ...base, kind: "type-coarse-mismatch" };
          }
        }
        return { ...base, kind: "ok" };
      }

      // A non-closer token opens / continues another argument.
      if (currentArgCount >= declaredArity) return { ...base, kind: "overfull-open" };
      return { ...base, kind: "ok" };
    },
  };
}
