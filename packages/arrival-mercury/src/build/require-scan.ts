/**
 * The require-lowering under build mode — the PRE-WALK scan (design doc §3/§4).
 * `walker/walk.ts`'s `WalkOptions.requireOf` hook decides what a `Require` node
 * lowers to once the walker is already mid-tree; this module answers the question
 * that has to be settled BEFORE any of that: which sibling does each
 * `(require "…")` name, and under which of the three shapes ESM cares about?
 *
 *   - `"spill"` — a bare, unbound top-level `(require "x.scm")`: run-once-and-
 *     spill-defines (design doc §3's module-semantics reading). The compiled
 *     equivalent is a NAMED import of every symbol the sibling exports; the
 *     `Require` node ITSELF contributes no statement (see walk.ts's own comment
 *     on its statement-position `requireOf` sites).
 *   - `"bound"` — `(define x (require "y"))`: `x` becomes a default import of
 *     `y`'s program-face value, aliased to the user's own chosen name.
 *   - `"inline"` — anywhere else a `Require` CoreForm can appear (a call
 *     argument, a let binding's init, …): a default import, aliased from the
 *     required path since there's no user-chosen name to borrow.
 *
 * Purely structural — never touches source text, never re-parses; walks the
 * ALREADY-classified forms exactly once, exhaustively over CoreForm's 16
 * members (mirrors `walker/walk.ts`'s own `selfTailOnly` traversal shape).
 */
import type {
  And,
  App,
  Begin,
  CoreForm,
  Define,
  DefineFn,
  Dict,
  Door,
  If,
  Lambda,
  Let,
  Lit,
  NamedLet,
  Or,
  Quote,
  Ref,
  Require,
} from "../coreform/types.js";

export type RequireOccurrence =
  | { readonly kind: "spill"; readonly node: Require }
  | { readonly kind: "bound"; readonly node: Require; readonly boundName: string }
  | { readonly kind: "inline"; readonly node: Require };

function exhausted(x: never): never {
  throw new Error(`require-scan: unhandled CoreForm kind ${JSON.stringify(x)}`);
}

/** Every `Require` occurrence reachable from `forms`, in first-encounter order.
 *  Top-level bare/`define`-bound requires are classified specially; every OTHER
 *  occurrence — at any depth, inside any of the other 14 CoreForm shapes — is
 *  `"inline"`. */
export function scanRequires(forms: readonly CoreForm[]): RequireOccurrence[] {
  const out: RequireOccurrence[] = [];

  const visitInline = (n: CoreForm): void => {
    switch (n.kind) {
      case "Require":
        out.push({ kind: "inline", node: n });
        return;
      case "Define": {
        const d = n as Define;
        visitInline(d.value);
        if (d.overridableType !== undefined) visitInline(d.overridableType);
        return;
      }
      case "DefineFn": {
        const d = n as DefineFn;
        if (d.overridableType !== undefined) visitInline(d.overridableType);
        for (const b of d.body) visitInline(b);
        return;
      }
      case "Lambda": {
        const l = n as Lambda;
        for (const b of l.body) visitInline(b);
        return;
      }
      case "If": {
        const i = n as If;
        visitInline(i.cond);
        visitInline(i.then);
        visitInline(i.else);
        return;
      }
      case "And":
      case "Or": {
        const a = n as And | Or;
        for (const arg of a.args) visitInline(arg);
        return;
      }
      case "Let":
      case "NamedLet": {
        const l = n as Let | NamedLet;
        for (const b of l.bindings) visitInline(b.init);
        for (const b of l.body) visitInline(b);
        return;
      }
      case "Begin": {
        const b = n as Begin;
        for (const f of b.body) visitInline(f);
        return;
      }
      case "App": {
        const a = n as App;
        visitInline(a.fn);
        for (const arg of a.positionalArgs) visitInline(arg);
        for (const e of a.kwargs) visitInline(e.value);
        return;
      }
      case "Dict": {
        const d = n as Dict;
        for (const e of d.entries) visitInline(e.value);
        return;
      }
      case "Quote":
      case "Ref":
      case "Lit":
      case "Door":
        return;
      default:
        return exhausted(n as never);
    }
  };

  for (const form of forms) {
    if (form.kind === "Require") {
      out.push({ kind: "spill", node: form });
    } else if (form.kind === "Define" && form.value.kind === "Require") {
      out.push({ kind: "bound", node: form.value, boundName: form.name });
      if (form.overridableType !== undefined) visitInline(form.overridableType);
    } else {
      visitInline(form);
    }
  }
  return out;
}

/** R7RS top-level `(begin …)` splices — the SAME pure transform `walker/walk.ts`
 *  applies internally before its own main loop. Duplicated here (not exported by
 *  that module) so this package's export-contract logic sees EXACTLY the top-
 *  level form list the walker actually iterates — never a divergent view of
 *  "what's the last top-level form" or "what are this file's own defines". */
export function flattenTopBegins(forms: readonly CoreForm[]): CoreForm[] {
  const out: CoreForm[] = [];
  for (const f of forms) {
    if (f.kind === "Begin") out.push(...flattenTopBegins(f.body));
    else out.push(f);
  }
  return out;
}

/** Every top-level `Define`/`DefineFn` name, in source order — the module face's
 *  named-export set (design doc §3: "every top-level define → named export"). */
export function topLevelDefineNames(flatForms: readonly CoreForm[]): string[] {
  return flatForms.filter((f): f is Define | DefineFn => f.kind === "Define" || f.kind === "DefineFn").map((f) => f.name);
}

/** Does `flatForms` end in a genuine program-face expression (design doc §3:
 *  "iff the file ends in a non-define expression")? A trailing bare `Require` is
 *  deliberately EXCLUDED — `walk()`'s top-level loop always lowers a non-define
 *  top-level form through `lowerStmts` (never `lowerTail`), so a require's value
 *  there is unconditionally discarded; there is no trailing VALUE to export. */
export function hasProgramFace(flatForms: readonly CoreForm[]): boolean {
  const last = flatForms.at(-1);
  return last !== undefined && last.kind !== "Define" && last.kind !== "DefineFn" && last.kind !== "Require";
}
