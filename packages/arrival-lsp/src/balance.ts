// balance — close an INCOMPLETE scheme prefix so it parses. Split out of
// service-core so the tsgo backend's browser worker can import it WITHOUT
// dragging `typescript` into its chunk (service-core re-exports it, every
// existing import path still works).

/**
 * Balance an INCOMPLETE scheme prefix so it parses — for the cursor-position queries
 * (completion / quick-info), which by nature run on a mid-edit, usually-unbalanced prefix.
 * `emitTypes` requires a complete, parseable program (`parseSexprs` throws on an unclosed
 * paren → the whole emit degrades to an empty module → no span at the cursor → no completions).
 * Appending the missing close delimiters makes the prefix parse; the suffix is added at the END,
 * so every cursor offset within the original prefix maps unchanged. String / line-comment /
 * block-comment / char-literal aware, matching arrival's lexer (brackets `()[]` are
 * interchangeable on close, so a single `)` per open level suffices). The diagnostics path does
 * NOT balance — a genuinely malformed complete program should report its errors, not be repaired.
 */
export function balancePrefix(scheme: string): string {
  let depth = 0;
  let inStr = false;
  let esc = false;
  let inLine = false;
  let block = 0;
  for (let i = 0; i < scheme.length; i++) {
    const c = scheme[i]!;
    if (inLine) {
      if (c === "\n") inLine = false;
      continue;
    }
    if (block > 0) {
      if (c === "#" && scheme[i + 1] === "|") {
        block++;
        i++;
      } else if (c === "|" && scheme[i + 1] === "#") {
        block--;
        i++;
      }
      continue;
    }
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === "#" && scheme[i + 1] === "\\") {
      i += 2;
      continue;
    } // char literal `#\(` — skip the next char
    if (c === '"') inStr = true;
    else if (c === ";") inLine = true;
    else if (c === "#" && scheme[i + 1] === "|") {
      block = 1;
      i++;
    } else if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
  }
  // An unterminated string can't be balanced into a valid token — close it too, then the parens.
  return scheme + (inStr ? '"' : "") + ")".repeat(depth);
}

/**
 * The TS string-literal TYPE for a candidate token that IS a quoted string
 * literal (`"thai"` → `"thai"`), or `null` for anything else (a bound symbol
 * `thai`, a builtin `car`, an operator `+`, a number `42`, an unterminated
 * `"un`-closed). Used by the type-lens probes to embed a quoted-string
 * candidate as the literal type it denotes — so an enum-union slot can prove it
 * IN or OUT (`["thai"] extends [Cuisine]`) instead of the candidate degrading
 * to `typeof __arr["\"thai\""]` = `any` (kept-blind, the literal-narrowing gap).
 *
 * Discriminant: a well-formed double-quoted JSON string. `JSON.parse` validates
 * it is a single complete string token (rejecting `"a" "b"`, bare atoms,
 * numbers, and malformed escapes); `JSON.stringify` of the parsed value yields
 * the canonical TS literal spelling (escapes normalised the SAME way the
 * emitter's `JSON.stringify(decodeString(...))` normalises an emitted string
 * literal, so the candidate side and the program side speak one literal
 * vocabulary). A non-string parse (`"42"` is a string, but `42`/`true`/`null`
 * are not double-quoted so never reach here) or any parse failure → `null`,
 * which the caller maps to the conservative `typeof` path (kept). The result is
 * a complete TS type expression, safe to interpolate into `__ok<…>`.
 */
export function stringLiteralType(candidate: string): string | null {
  if (candidate.length < 2 || candidate[0] !== '"' || candidate.at(-1) !== '"') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch {
    return null; // not a single well-formed string token → conservative typeof path
  }
  return typeof parsed === "string" ? JSON.stringify(parsed) : null;
}
