/**
 * Identifier naming. v1 is the `cleanName` base of the ladder defined in
 * `here.build/docs/package-specific/mercury-compiler/lexical-js-naming.md` — kebab→camel, drop predicate
 * `?` / mutate `!`, lower `->`, escape reserved words. It is a PURE function of
 * the scheme name, position-independent, so for a collision-free program (every
 * example chain so far) it is exactly the name the full namer would assign at
 * T100.
 *
 * The collision-resolution upgrade — running `@here.build/lexical-namer` over a
 * scope tree so two bindings that clean to the same JS name in overlapping scopes
 * get a deterministic `${name}_${postfix}` — slots in here without touching the
 * lowering pass (it only changes what `cleanName` returns per binding). See the
 * package SPEC §7. Tracked as its own task.
 */
import pluralize from "pluralize";

import { isAtom, isKeyword, isList, keywordName, type Node } from "./nodes.js";

const RESERVED = new Set([
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "new",
  "null",
  "return",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "let",
  "static",
  "enum",
  "await",
  "async",
  "implements",
  "interface",
  "package",
  "private",
  "protected",
  "public",
  "arguments",
  "eval",
]);

/**
 * Scheme identifier → JS identifier. Pure, total, deterministic.
 *   run-predict  → runPredict
 *   dominates?   → dominates
 *   string->list → stringToList
 *   set-x!       → setX
 */
export function cleanName(scheme: string): string {
  let s = scheme;
  s = s.replaceAll("->", "-to-"); // string->list → string-to-list
  s = s.replaceAll(/[?!]/g, ""); // predicate? / mutate! markers carry no JS meaning
  s = s.replaceAll("*", ""); // earmuffed *globals*
  s = s.replaceAll(/[^\w-]/g, "-"); // any other punctuation → separator
  s = s.replaceAll(/[-_]+([a-z0-9])/gi, (_m, c: string) => c.toUpperCase()); // kebab/snake → camel
  s = s.replaceAll(/[-_]+$/g, ""); // trailing separators
  if (s === "") s = "_";
  if (/^\d/.test(s)) s = `_${s}`;
  if (RESERVED.has(s)) s = `${s}_`;
  return s;
}

/**
 * The friendly-name LADDER for a scheme identifier — preference-ordered JS-name
 * candidates a collision resolver tries in turn before falling to a `_2` postfix
 * (the `is<Symbol>` rung of the ladder in `here.build/docs/package-specific/mercury-compiler/lexical-js-naming.md`).
 *
 * Tier 1 is always `cleanName`. A predicate `foo?` gets a 2nd tier `isFoo` — the JS
 * boolean convention — so when `foo` is already taken (a loop var shadows the
 * predicate, as `picked` shadows `picked?` in gepa-full) the resolver picks the
 * readable `isFoo`, not `foo_2`. Pure function of the name; the scope-aware resolver
 * that consumes it is task #76.
 */
export function nameCandidates(scheme: string): string[] {
  const base = cleanName(scheme);
  // A predicate whose base doesn't already READ as a boolean → offer `isBase` next.
  // Skip when it already starts with a boolean verb (`hasChildren`, not `isHasChildren`).
  const reads = /^(is|has|can|should|will|was|had|are)[A-Z]/.test(base);
  if (scheme.endsWith("?") && base !== "" && base !== "_" && !reads) {
    return [base, `is${base.charAt(0).toUpperCase()}${base.slice(1)}`];
  }
  return [base];
}

/**
 * A readable singular element name for a collection node, or null (the caller falls
 * back to a generic `__x`). The "magic" that turns `examples.map((__x) => …)` into
 * `examples.map((example) => …)`. Fires only when the collection name is genuinely
 * plural:
 *   examples      → example
 *   (:scores c)   → score      (accessor field name)
 *   (scores a)    → score      (a getter call whose name is plural)
 *   pool / data   → null       (singular === base, nothing gained)
 * Never returns `acc` — that name is reserved for the reduce accumulator.
 */
export function elementName(list: Node): string | null {
  let base: string | undefined;
  if (isAtom(list) && !list.str) base = cleanName(list.atom);
  else if (isList(list) && isKeyword(list.list[0]))
    base = cleanName(keywordName(list.list[0])); // (:scores c)
  else if (isList(list) && isAtom(list.list[0]) && !list.list[0].str) base = cleanName(list.list[0].atom); // (scores a)
  if (base === undefined || base === "") return null;
  const singular = pluralize.singular(base);
  if (!singular || singular === base || singular === "acc") return null;
  return singular;
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth"];
const ordinal = (k: number): string => ORDINALS[k] ?? `item${k + 1}`;

/**
 * The namer's tuple solver. If `param` is consumed ONLY as `param[N]` (literal
 * indices) in `body`, return an array-destructuring pattern + the body rewritten to
 * the positional names:
 *   `__x[0]` (index 0 only)        → `[head]`            + `head`
 *   `pair[1]` (highest index ≥ 1)  → `[first, second]`   + `second`
 * Returns null when the param is ever used whole (it then can't be safely
 * destructured) or is never index-accessed. v1 works on the lowered body string;
 * a malformed match (param[N] inside a string literal) is the known limit.
 */
export function destructureTuple(param: string, body: string): { pattern: string; body: string } | null {
  const esc = param.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
  const idxRe = new RegExp(String.raw`\b${esc}\[(\d+)\]`, "g");
  const indices = [...body.matchAll(idxRe)].map((m) => Number(m[1]));
  if (indices.length === 0) return null;
  // Used whole somewhere (outside an index) → can't destructure.
  if (new RegExp(String.raw`\b${esc}\b`).test(body.replace(idxRe, ""))) return null;
  const max = Math.max(...indices);
  const nameAt = (k: number): string => (max === 0 ? "head" : ordinal(k));
  const slots = max === 0 ? ["head"] : Array.from({ length: max + 1 }, (_v, k) => ordinal(k));
  const rewritten = body.replace(idxRe, (_m, n: string) => nameAt(Number(n)));
  return { pattern: `[${slots.join(", ")}]`, body: rewritten };
}

/**
 * Does lowered JS code contain a REAL `await` keyword — not the substring inside
 * a string/template literal (`(or x "await")`) or an identifier (`awaited`)?
 * The emitter's async decisions sniff lowered strings (the string-plane half of
 * the two-plane async story; the scheme-plane half is async-analysis.ts) — a raw
 * `.includes("await")` false-positives on literal content and then injects
 * `await` into a function the scheme plane correctly left sync: a SyntaxError,
 * or a spuriously-async lambda whose callers never await it. This scanner drops
 * quoted literal TEXT but keeps template `${…}` interiors (a real await inside an
 * interpolation still counts), then tests `\b`-bounded `await`. Lowered code
 * never contains comments, so quotes are the only lexical hazard.
 */
export function containsAwaitToken(code: string): boolean {
  if (!code.includes("await")) return false;
  let out = "";
  type Frame = { mode: "code"; depth: number } | { mode: "dq" | "sq" | "tpl" };
  const stack: Frame[] = [{ mode: "code", depth: 0 }]; // ${…} nests full code (incl. nested templates)
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!;
    const top = stack.at(-1)!;
    if (top.mode === "code") {
      if (ch === '"') stack.push({ mode: "dq" });
      else if (ch === "'") stack.push({ mode: "sq" });
      else if (ch === "`") stack.push({ mode: "tpl" });
      else if (ch === "{") {
        top.depth++;
        out += ch;
        continue;
      } else if (ch === "}") {
        if (top.depth > 0) {
          top.depth--;
          out += ch;
        } else if (stack.length > 1) {
          stack.pop(); // close of THIS ${…} interpolation — back to template text
        }
        continue;
      } else {
        out += ch;
        continue;
      }
      out += " "; // token separator where a literal starts
      continue;
    }
    if (ch === "\\") {
      i++; // skip escaped char in any literal mode
      continue;
    }
    if (top.mode === "dq" && ch === '"') stack.pop();
    else if (top.mode === "sq" && ch === "'") stack.pop();
    else if (top.mode === "tpl" && ch === "`") stack.pop();
    else if (top.mode === "tpl" && ch === "$" && code[i + 1] === "{") {
      stack.push({ mode: "code", depth: 0 }); // interpolation interior IS code — scan it
      i++;
    }
  }
  return /\bawait\b/.test(out);
}
