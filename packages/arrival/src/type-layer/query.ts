// query — T, the type half of the Σ∩T NARROW (docs/static-plane.md §THE Σ∩T NARROW,
// §THE FOUR READERS 4.1): the core query lens over a harvested prelude.
//
// "Scheme is a TS subset except lists and pairs." The lens lowers a scheme prefix to TS
// (lower.ts), compiles it against the harvested prelude (prelude.ts), and reads the TYPE
// at the cursor's argument slot back off the checker. It answers five questions:
//
//   • getTypeValidCandidates  — the subset of the sampler's Σ candidates that are TYPE-VALID
//     as the next token of the slot under the cursor (the Σ∩T mask).
//   • getSlotArrayKind        — the slot's 3-way value verdict: list / vector / scalar (null
//     when unresolved).
//   • getSlotElementType      — the slot's element-DOMAIN: a PROVABLY CLOSED string-literal
//     `enum` (the highest-value narrow — an enum/closed-domain arg → its member set), or a
//     free-form-`string` `isStringy` flag (both null on uncertainty).
//   • getSlotAcceptsBareWord  — is a bare value-word admissible here as a string (null when
//     unresolved).
//   • getSlotIsStringTyped    — is the slot a string subtype, not an array (null when unresolved).
//
// ★THE GOVERNING INVARIANT — CONSERVATIVE, DROPS-ONLY (the type-lens voice of the one
// conservative-narrowing law: docs/static-plane.md §CONSERVATIVE NARROWING). An axis narrows
// ONLY when it can PROVE the constraint (a candidate PROVABLY ill-typed at the slot, a slot NOT
// `any`/`unknown`/`never`/out-of-range). On ANY uncertainty it returns the unresolved value
// (candidate list unchanged, or null) — a wrongly-dropped valid candidate is a DEFECT, never a
// tradeoff. Every keep/null path below is annotated with the uncertainty it absorbs.
//
// Mechanism (ONE compile per query — the slot type is extracted once, then candidates are
// filtered against it; never a compile-per-candidate):
//   1. insert a unique SENTINEL atom at the cursor; balance the (mid-edit) prefix; lower().
//   2. PARSE the lowered TS (no checker — a cheap createSourceFile) and walk to the SENTINEL's
//      enclosing ts.CallExpression → the callee text + the argument index `i`.
//   3. the slot's expected type is `Parameters<typeof <callee>>[i]`; compile the prelude + that
//      alias + one `declare const` per candidate; read the types off ONE TypeChecker.
//   4. keep a candidate iff its own value-type — or, as a sub-call head, its (awaited) RETURN
//      type — is assignable to the slot; keep on every uncertainty.

import * as ts from "typescript";

import { compile } from "./compile-host.js";
import { lower } from "./lower.js";
import { escapeName, isTsIdentifier } from "./name-escape.js";
import type { HarvestedPrelude } from "./prelude.js";

/** A clean-name-proof cursor atom: an identifier no scheme program or builtin uses, so its
 *  lowered TS identifier is unambiguous to locate. */
const SENTINEL = "qzcursorzq";

/** The cursor's slot role. `argument` is the only T-narrowable position; an operator slot, a
 *  top-level position, or an unparseable prefix all collapse to `none` (→ keep everything).
 *  `propertyKey` is set when the cursor is a kwargs/object value (`(f :name |)` → `f({ name: … })`),
 *  so the slot narrows to that property's type, not the whole object. */
type Role = { kind: "argument"; calleeText: string; argIndex: number; propertyKey?: string } | { kind: "none" };

/** The 3-way value-slot verdict (the carrier `SlotKind`'s "string" folds into "scalar" — a
 *  string is a scalar value, not an array). `null` = unresolved (superset-safe). */
export type SlotArrayKind = "list" | "vector" | "scalar";

/**
 * The slot's element-domain verdict (the highest-value narrowing axis). The "domain" is the
 * element type for a list/vector/quote slot (`ElemOf<__E>`), else the slot type itself.
 *   • `enum`      — the members of a PROVABLY CLOSED string-literal domain (`"fast" | "scenic"`).
 *                   A consumer narrows the slot to exactly these words. `null` unless every
 *                   constituent is a string literal — one non-literal constituent reopens the
 *                   domain → `null` (superset-safe; never narrow a domain we can't close).
 *   • `isStringy` — `true` iff the domain is the FREE-FORM `string` type (a bare word is an
 *                   admissible value); `null` otherwise. Mutually exclusive with `enum`.
 * Both `null` on any uncertainty (no call, unknown callee, an `any`/`unknown` domain).
 */
interface SlotElementType {
  readonly isStringy: boolean | null;
  readonly enum: readonly string[] | null;
}

export interface QueryLens {
  /**
   * The Σ∩T mask. Given the cursor and the sampler's `candidates`, return the subset that is
   * TYPE-VALID as the next token of the argument slot under the cursor. DROPS-ONLY: a candidate
   * is removed only when PROVABLY ill-typed; an unresolved candidate, an unresolved slot, or a
   * cursor that is not a typed-call argument all KEEP every candidate.
   */
  getTypeValidCandidates(scheme: string, cursorOffset: number, candidates: readonly string[]): string[];
  /**
   * The slot's value-shape verdict at the cursor: "list" / "vector" / "scalar", or `null` when
   * unresolved (not a typed-call argument, unknown callee, an un-nameable / `any`/`unknown` slot).
   */
  getSlotArrayKind(scheme: string, cursorOffset: number): SlotArrayKind | null;
  /** The slot's element-domain verdict — see `SlotElementType`. Held to the same drops-only
   *  discipline: never close a domain we can't prove closed. */
  getSlotElementType(scheme: string, cursorOffset: number): SlotElementType;
  /**
   * Does the slot admit a BARE WORD as a string (a free-form string slot)? `true`/`false` via the
   * `AcceptsBareWord<__E>` carrier; `null` when the slot is unresolved (superset-safe).
   */
  getSlotAcceptsBareWord(scheme: string, cursorOffset: number): boolean | null;
  /**
   * Is the slot STRING-TYPED (a string subtype, not an array) via the `IsStringTyped<__E>`
   * carrier? `true`/`false` for a resolved slot; `null` when unresolved (superset-safe).
   */
  getSlotIsStringTyped(scheme: string, cursorOffset: number): boolean | null;
}

/** Build a query lens over a harvested prelude (carrier vocabulary + one `declare const` per
 *  grant tool). The prelude text is captured once; each query emits ONE virtual probe file over
 *  it. */
export function createQueryLens(harvested: HarvestedPrelude): QueryLens {
  const preludeText = harvested.prelude;

  /** Locate the cursor's slot role: insert the sentinel, balance the prefix, lower to TS, parse,
   *  and walk to the sentinel's enclosing call. An unparseable lowering → `none` (keep all). */
  function roleAt(scheme: string, cursorOffset: number): Role {
    const sentineled = balance(`${scheme.slice(0, cursorOffset)} ${SENTINEL} ${scheme.slice(cursorOffset)}`);
    let loweredTs: string;
    try {
      loweredTs = lower(sentineled).ts;
    } catch {
      return { kind: "none" }; // a prefix that won't lower → no slot → keep everything
    }
    return findRole(loweredTs);
  }

  /** Compile ONE probe over the slot under the cursor: the prelude + `__E = Parameters<…>[i]` +
   *  `declare const __slot: __E` + the caller's extra declarations; return the checker/sourceFile.
   *  Returns `null` (a superset-safe no-op for every caller) when there is no argument slot, the
   *  compile host fails, OR the slot is UNRESOLVED (`any`/`unknown`/`never`/`undefined` — unknown
   *  callee, out-of-range index, a door callee). The `__slot` uncertainty gate is the single
   *  choke-point that makes all three narrowing axes drops-only. */
  function probeSlot(
    scheme: string,
    cursorOffset: number,
    extra: readonly string[],
  ): { checker: ts.TypeChecker; sourceFile: ts.SourceFile } | null {
    const role = roleAt(scheme, cursorOffset);
    if (role.kind !== "argument") return null; // operator / top / unparseable → no T narrowing
    const probe = [
      preludeText,
      `type __E = ${slotTypeExpr(role)};`,
      `declare const __slot: __E;`,
      ...extra,
    ].join("\n");
    const compiled = compile(probe);
    if (compiled === null) return null; // compile host failure → uncertain
    const slot = typeAt(compiled.checker, compiled.sourceFile, "__slot");
    if (slot === null || isUncertain(slot)) return null; // unresolved slot → superset-safe no-op
    return compiled;
  }

  return {
    getTypeValidCandidates(scheme, cursorOffset, candidates): string[] {
      const cands = [...candidates];
      if (cands.length === 0) return cands;
      const role = roleAt(scheme, cursorOffset);
      if (role.kind !== "argument") return cands; // operator / top / unparseable → no T narrowing

      const probe = [
        preludeText,
        `type __E = ${slotTypeExpr(role)};`,
        `declare const __slot: __E;`,
        ...cands.map((c, i) => `declare const __c${i}: ${candidateTypeExpr(c)};`),
      ].join("\n");
      const compiled = compile(probe);
      if (compiled === null) return cands; // compile host failure → keep all (uncertain)
      const { checker, sourceFile } = compiled;

      const slot = typeAt(checker, sourceFile, "__slot");
      // Unresolved slot (unknown callee → any, out-of-range index → undefined, a `never`/door
      // callee → never): no provable verdict → keep every candidate.
      if (slot === null || isUncertain(slot)) return cands;

      return cands.filter((_, i) => {
        const candType = typeAt(checker, sourceFile, `__c${i}`);
        if (candType === null) return true; // unreadable candidate type → keep (uncertain)
        return candidateFits(checker, candType, slot);
      });
    },

    getSlotArrayKind(scheme, cursorOffset): SlotArrayKind | null {
      const role = roleAt(scheme, cursorOffset);
      if (role.kind !== "argument") return null;

      const probe = [
        preludeText,
        `type __E = ${slotTypeExpr(role)};`,
        `declare const __slot: __E;`,
        `declare const __kind: SlotKind<__E>;`,
      ].join("\n");
      const compiled = compile(probe);
      if (compiled === null) return null;
      const { checker, sourceFile } = compiled;

      const slot = typeAt(checker, sourceFile, "__slot");
      if (slot === null || isUncertain(slot)) return null; // unresolved slot → null (superset-safe)
      const kind = typeAt(checker, sourceFile, "__kind");
      if (kind === null || !kind.isStringLiteral()) return null; // a union/non-literal → unresolved
      return collapseKind(kind.value);
    },

    getSlotElementType(scheme, cursorOffset): SlotElementType {
      // The DOMAIN to inspect: a list/vector/quote slot's ELEMENT (`ElemOf<__E>`), else the slot
      // type itself. `ElemOf<__E>` is `never` for a scalar slot (`string`, an enum, a number), so
      // the `[ElemOf<__E>] extends [never]` fork falls back to `NonNullable<__E>` — letting a
      // DIRECT enum/string param and an ARRAY-of-enum/string param fold to the same domain query.
      const compiled = probeSlot(scheme, cursorOffset, [
        `type __Domain = [ElemOf<__E>] extends [never] ? NonNullable<__E> : ElemOf<__E>;`,
        `declare const __domain: __Domain;`,
      ]);
      if (compiled === null) return UNRESOLVED_ELEMENT; // no slot / unresolved → both null
      const domain = typeAt(compiled.checker, compiled.sourceFile, "__domain");
      // An `unknown` element (a `List<unknown>` / `readonly unknown[]` slot) is uncertain → no proof.
      if (domain === null || isUncertain(domain)) return UNRESOLVED_ELEMENT;

      const members = closedStringEnum(domain);
      if (members !== null) return { isStringy: null, enum: members }; // a PROVED closed string set
      if ((domain.flags & ts.TypeFlags.String) !== 0) return { isStringy: true, enum: null }; // free-form `string`
      return UNRESOLVED_ELEMENT; // a number / boolean / opaque element → narrow nothing
    },

    getSlotAcceptsBareWord(scheme, cursorOffset): boolean | null {
      const compiled = probeSlot(scheme, cursorOffset, [`declare const __bare: AcceptsBareWord<__E>;`]);
      if (compiled === null) return null; // no slot / unresolved → null (superset-safe)
      return readBoolLiteral(compiled.checker, typeAt(compiled.checker, compiled.sourceFile, "__bare"));
    },

    getSlotIsStringTyped(scheme, cursorOffset): boolean | null {
      const compiled = probeSlot(scheme, cursorOffset, [`declare const __str: IsStringTyped<__E>;`]);
      if (compiled === null) return null; // no slot / unresolved → null (superset-safe)
      return readBoolLiteral(compiled.checker, typeAt(compiled.checker, compiled.sourceFile, "__str"));
    },
  };
}

/** The both-null element verdict — returned on every uncertainty path (frozen so callers can't
 *  mutate the shared sentinel). */
const UNRESOLVED_ELEMENT: SlotElementType = Object.freeze({ isStringy: null, enum: null });

/** Enumerate a PROVABLY CLOSED string-literal domain's members. A union is closed iff EVERY
 *  constituent is a string literal (one `string`/`number`/symbol constituent reopens it →
 *  `null`); a single string-literal type is a one-member closed domain. Anything else → `null`.
 *  This is the proof that makes the enum narrow drops-only: we return members ONLY when the
 *  whole domain is provably this finite word set. */
function closedStringEnum(t: ts.Type): readonly string[] | null {
  if (t.isStringLiteral()) return [t.value];
  if (!t.isUnion()) return null;
  const members: string[] = [];
  for (const c of t.types) {
    if (!c.isStringLiteral()) return null; // a non-string-literal constituent → not a closed string set
    members.push(c.value);
  }
  return members.length > 0 ? members : null;
}

/** Read a carrier predicate's resolved `true`/`false` literal off the checker. A resolved slot
 *  collapses `AcceptsBareWord`/`IsStringTyped` to exactly one boolean-LITERAL type; anything else
 *  (a `boolean` union, an absent declaration, a non-boolean) is uncertain → `null`. */
function readBoolLiteral(checker: ts.TypeChecker, t: ts.Type | null): boolean | null {
  if (t === null || (t.flags & ts.TypeFlags.BooleanLiteral) === 0) return null;
  const s = checker.typeToString(t);
  return s === "true" ? true : s === "false" ? false : null;
}

// ── candidate / slot assignability ───────────────────────────────────────────

/** Keep a candidate iff its value — or, used as a sub-call HEAD, its (awaited) RETURN value — is
 *  assignable to the slot. The function-return arm is load-bearing: the next token at an argument
 *  slot is usually a sub-call's operator (`(get_route (make_route) …)`), so a list-RETURNING symbol
 *  must be kept at a list slot even though its function-type is not itself a list. Every branch
 *  KEEPS on uncertainty (`any`/`unknown`/`never`/`undefined`), so only a provably ill-typed
 *  candidate returns `false`. */
function candidateFits(checker: ts.TypeChecker, candType: ts.Type, slot: ts.Type): boolean {
  if (isUncertain(candType)) return true; // unresolved candidate (a local, an undeclared tool) → keep
  if (checker.isTypeAssignableTo(candType, slot)) return true; // its value goes straight in the slot
  for (const sig of checker.getSignaturesOfType(candType, ts.SignatureKind.Call)) {
    // A sub-call head: the awaited return value is what lands in the slot (rosetta tools are async,
    // so the bake awaits — compare `Awaited<R>`, which is `R` for a sync native head).
    const raw = checker.getReturnTypeOfSignature(sig);
    const ret = checker.getAwaitedType(raw) ?? raw;
    if (isUncertain(ret)) return true; // a generic / `unknown` return → keep
    if (checker.isTypeAssignableTo(ret, slot)) return true;
  }
  return false; // PROVABLY ill-typed at this slot — the only path that drops
}

/** The slot/candidate types whose presence means "no proof either way → KEEP". `any`/`unknown`
 *  are the unresolved sentinels; `never` is a door/keyword callee or an empty signature union;
 *  `undefined` is an out-of-range tuple index (`Parameters<F>[i]`, i ≥ arity). */
function isUncertain(t: ts.Type): boolean {
  return (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never | ts.TypeFlags.Undefined)) !== 0;
}

/** A candidate's TS type expression for the probe: an identifier-safe name resolves as
 *  `typeof <name>` (a prelude `declare const`, a carrier global, or — if undeclared — an
 *  error-`any` that is kept); a non-identifier name routes through the `_` namespace under its
 *  ESCAPED, dotted name (`typeof _.get$dash$route`), mirroring lower.ts's own head dispatch. The
 *  dotted form (not `_["…"]`) is what lets `typeof` walk it — see name-escape.ts. */
function candidateTypeExpr(name: string): string {
  return isTsIdentifier(name) ? `typeof ${name}` : `typeof _.${escapeName(name)}`;
}

/** Fold the carrier `SlotKind` literal into the 3-way array verdict ("string" → "scalar"); any
 *  unexpected literal → `null` (defensive — never assert a kind we can't name). */
function collapseKind(kind: string): SlotArrayKind | null {
  if (kind === "list" || kind === "vector" || kind === "scalar") return kind;
  if (kind === "string") return "scalar";
  return null;
}

// ── role finding (a pure parse — no checker) ─────────────────────────────────

/** Parse the lowered TS and walk to the SENTINEL identifier's enclosing call: inside the
 *  arguments → `argument` + callee text + arg index; as the callee (operator position) or with no
 *  enclosing call (top) → `none`. The innermost enclosing call wins (so a nested `(f (g …))`
 *  reports `g`, not `f`). A parse, not a compile — `setParentNodes` lets us climb to `.parent`. */
function findRole(loweredTs: string): Role {
  const sourceFile = ts.createSourceFile("__role.ts", loweredTs, ts.ScriptTarget.ES2022, true);
  let role: Role = { kind: "none" };
  let done = false;
  const visit = (node: ts.Node): void => {
    if (done) return;
    if (ts.isIdentifier(node) && node.text === SENTINEL) {
      done = true; // exactly one sentinel — its role is final
      const start = node.getStart(sourceFile);
      const end = node.getEnd();
      for (let p: ts.Node | undefined = node.parent; p !== undefined; p = p.parent) {
        if (!ts.isCallExpression(p)) continue;
        const argIndex = p.arguments.findIndex((a) => a.getStart(sourceFile) <= start && end <= a.end);
        if (argIndex !== -1) {
          const propertyKey = objectPropertyAt(p.arguments[argIndex], start, end, sourceFile);
          role = { kind: "argument", calleeText: p.expression.getText(sourceFile), argIndex, propertyKey };
          return;
        }
        if (p.expression.getStart(sourceFile) <= start && end <= p.expression.end) return; // operator slot → none
      }
      return; // top-level → none
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return role;
}

/** If the argument is an object literal `{ k: … }` and the sentinel sits in property `k`'s VALUE,
 *  return `k` — so the slot narrows to the property type (`…[arg]["k"]`), not the whole object.
 *  This is the kwargs/dict value probe (`(f :name |)` → `f({ name: … })`). A sentinel in a property
 *  NAME (a key being typed) returns undefined → the whole-object slot → keep-all, since key
 *  narrowing is the profile gate's job, not the lens's. */
function objectPropertyAt(arg: ts.Expression, start: number, end: number, sf: ts.SourceFile): string | undefined {
  if (!ts.isObjectLiteralExpression(arg)) return undefined;
  for (const prop of arg.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const init = prop.initializer;
    if (init.getStart(sf) <= start && end <= init.end) {
      return ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name) ? prop.name.text : undefined;
    }
  }
  return undefined;
}

/** The TS type expression for the cursor's slot: the callee's parameter at `argIndex`, indexed into
 *  the kwargs property when the cursor is an object-literal value (`…[argIndex]["key"]`). */
function slotTypeExpr(role: { calleeText: string; argIndex: number; propertyKey?: string }): string {
  const base = `Parameters<typeof ${role.calleeText}>[${role.argIndex}]`;
  return role.propertyKey === undefined ? base : `${base}[${JSON.stringify(role.propertyKey)}]`;
}

// ── the virtual program ──────────────────────────────────────────────────────
// The single-compile host lives in compile-host.ts (shared with diagnose.ts). The query
// lens rides on top of intentionally-erroring probes (an undeclared candidate, an
// arity-loose call) and reads TYPES off the checker regardless of diagnostics.

/** Read the type of `declare const <name>: …` off the checker — locate the declaration's name
 *  identifier, then `getTypeAtLocation`. `null` when the declaration is absent (a corrupt probe). */
function typeAt(checker: ts.TypeChecker, sourceFile: ts.SourceFile, name: string): ts.Type | null {
  let result: ts.Type | null = null;
  const visit = (node: ts.Node): void => {
    if (result !== null) return;
    if (
      ts.isIdentifier(node) &&
      node.text === name &&
      ts.isVariableDeclaration(node.parent) &&
      node.parent.name === node
    ) {
      result = checker.getTypeAtLocation(node);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

// ── balance (a mid-edit prefix → a parseable program) ────────────────────────

/** Close an INCOMPLETE scheme prefix so it lowers — the sampler queries on a mid-generation,
 *  usually-unbalanced prefix (`lower` → `parseSexprs` throws on an unclosed paren). String /
 *  char-literal / line- and block-comment aware (arrival's lexer). The reader enforces STRICT
 *  bracket pairing (`(`→`)`, `[`→`]`, `{`→`}` — `[]`/`{}` are the vector/dict literals), so the
 *  suffix closes each open level with ITS OWN close char, innermost first. The suffix is
 *  appended at the END, so every cursor offset within the original prefix maps unchanged.
 *  Kept local (not imported from arrival/packages/arrival-lsp) to avoid a cross-package
 *  import. */
function balance(scheme: string): string {
  const opens: string[] = [];
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
      i += 2; // char literal `#\(` — skip the next char so a `(`/`)` in it is not counted
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === ";") inLine = true;
    else if (c === "#" && scheme[i + 1] === "|") {
      block = 1;
      i++;
    } else if (c === "(") opens.push(")");
    else if (c === "[") opens.push("]");
    else if (c === "{") opens.push("}");
    else if (c === ")" || c === "]" || c === "}") opens.pop();
  }
  return scheme + (inStr ? '"' : "") + opens.reverse().join("");
}
