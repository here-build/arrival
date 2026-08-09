/**
 * NAMES-ONLY DIFF — a review lens for diffs that are pure renaming.
 *
 * Binding-census / lexical-namer allocation regenerates the committed
 * emission fixtures with byte churn that is *supposed* to be pure renaming.
 * This checker splits that review: `namesOnlyDiff(committed, regenerated)`
 * answers "is this diff ONLY naming?" and, when yes, hands the judge the exact
 * old→new rename table — so naming reviews as naming, never as 41 opaque diffs.
 *
 * CONTRACT — alpha-equivalence, pragmatic form (NO scope analysis, by design):
 * two sources are equal-modulo-names iff their parse trees (`ts.createSourceFile`;
 * comments and whitespace are trivia, invisible by construction) are structurally
 * isomorphic — same node kinds, same shape, same literal content — AND the
 * identifiers at renameable positions admit one GLOBAL BIJECTIVE renaming:
 * pairing is positional (the i-th identifier of one tree against the i-th of the
 * other), each old name maps to exactly one new name and vice versa, and a name
 * may map to itself.
 *
 * Renameable positions (the local-binding namespace):
 *   declarations and references of local bindings — variable / function / class /
 *   type-alias names, parameters, array-destructure elements, object-destructure
 *   ALIASES (`{ key: alias }` — the alias), and plain identifier references
 *   (including call-site references to imports — pinned, see below).
 *
 * Byte-exact positions (never renameable):
 *   property access names (`x.foo`'s foo), object-literal keys, member/method
 *   names, `{ key: alias }`'s key, private identifiers, JSX attribute names,
 *   import/export specifiers, module strings, and string / number / template /
 *   regex literal content (per the scanner: strings and templates compare by
 *   cooked content, numerics by scanned value). Object SHORTHAND names
 *   (`{ foo }`, `const { foo } = o`) are byte-exact too: renaming those changes
 *   the tree shape (`{ foo: bar }`), which reports as structural divergence —
 *   deliberately, because a shape change deserves structural review.
 *
 * The import/export pin: import/export-bound names must match byte-exact AND
 * register as identity pairs in the bijection — so renaming only the call sites
 * of an import (leaving the specifier) honestly reports not-equal instead of
 * passing as a "consistent rename" of an unbound name.
 *
 * One-directional guarantee (the honest half the plan wants): when this reports
 * equal-modulo-names, the diff IS just naming — structure, literals, member
 * names and the import surface are untouched, and the renaming is globally
 * consistent. When it reports not-equal, `divergence` names the first point of
 * disagreement (node kind + position path); a few semantically pure renames
 * (the shorthand case above) land on the not-equal side on purpose.
 */
import ts from "typescript";

export interface NamesDiff {
  readonly equalModuloNames: boolean;
  /** old identifier → new identifier, the consistent renaming that witnesses
   *  equality (identity mappings omitted; empty when byte-equal). */
  readonly renames: ReadonlyMap<string, string>;
  /** human-readable first structural divergence when NOT equal-modulo-names
   *  (node kind + position path). */
  readonly divergence?: string;
}

const NO_RENAMES: ReadonlyMap<string, string> = new Map();

/** SyntaxKind → canonical name. The enum's First… / Last… / Count markers alias
 *  real kind values; skip them so paths read `NumericLiteral`, not `FirstLiteralToken`. */
const KIND_NAMES = (() => {
  const m = new Map<number, string>();
  for (const [name, value] of Object.entries(ts.SyntaxKind)) {
    if (typeof value !== "number" || /^(First|Last)[A-Z]/.test(name) || name === "Count") continue;
    if (!m.has(value)) m.set(value, name);
  }
  return m;
})();
const kindName = (kind: ts.SyntaxKind): string => KIND_NAMES.get(kind) ?? `SyntaxKind#${kind}`;

/**
 * How an identifier occurrence participates in the comparison. Namespace decides:
 *  - `renameable`   — local-binding namespace: joins the bijection.
 *  - `fixed-value`  — local-binding namespace but pinned (import/export-bound
 *                     names, object shorthand): byte-exact AND identity-registered
 *                     in the bijection, so drifting references get caught.
 *  - `fixed-opaque` — property/member namespace: byte-exact, outside the
 *                     bijection (a local and a property may share a name freely).
 */
type IdRole = "renameable" | "fixed-value" | "fixed-opaque";

function idRole(id: ts.Identifier): IdRole {
  const p = id.parent;
  // — property/member namespace —
  if (ts.isPropertyAccessExpression(p) && p.name === id) return "fixed-opaque";
  if (ts.isQualifiedName(p) && p.right === id) return "fixed-opaque";
  if (ts.isPropertyAssignment(p) && p.name === id) return "fixed-opaque";
  if (
    (ts.isPropertyDeclaration(p) ||
      ts.isPropertySignature(p) ||
      ts.isMethodDeclaration(p) ||
      ts.isMethodSignature(p) ||
      ts.isGetAccessorDeclaration(p) ||
      ts.isSetAccessorDeclaration(p) ||
      ts.isEnumMember(p)) &&
    p.name === id
  ) {
    return "fixed-opaque";
  }
  if (ts.isBindingElement(p) && p.propertyName === id) return "fixed-opaque"; // { key: alias } — the key
  if (ts.isJsxAttribute(p) && p.name === id) return "fixed-opaque";
  if (ts.isMetaProperty(p)) return "fixed-opaque"; // new.target / import.meta
  // remote halves of aliased specifiers live in the MODULE'S namespace, not ours:
  // `import { remote as local }` names/`export { local as remote }` re-names.
  if (ts.isImportSpecifier(p) && p.propertyName === id) return "fixed-opaque";
  if (ts.isExportSpecifier(p) && p.propertyName !== undefined && p.name === id) return "fixed-opaque";
  // — local-binding namespace, pinned —
  if (ts.isImportSpecifier(p) || ts.isImportClause(p) || ts.isNamespaceImport(p) || ts.isImportEqualsDeclaration(p)) {
    return "fixed-value";
  }
  if (ts.isExportSpecifier(p) || ts.isNamespaceExport(p)) return "fixed-value"; // `export { local }` references the local
  if (ts.isShorthandPropertyAssignment(p) && p.name === id) return "fixed-value"; // { foo } — key AND reference
  if (ts.isBindingElement(p) && p.propertyName === undefined && p.name === id && ts.isObjectBindingPattern(p.parent)) {
    return "fixed-value"; // const { foo } = o — key AND declaration
  }
  return "renameable";
}

/** Literal-like nodes whose `.text` is the comparison payload (checked AFTER the
 *  Identifier branch; SourceFile also has `.text` — never reaches here because
 *  the walk only text-compares this whitelist). */
const isTextCarrier = (n: ts.Node): boolean =>
  ts.isStringLiteralLike(n) || // StringLiteral | NoSubstitutionTemplateLiteral
  ts.isNumericLiteral(n) ||
  ts.isBigIntLiteral(n) ||
  ts.isRegularExpressionLiteral(n) ||
  ts.isTemplateLiteralToken(n) || // TemplateHead | TemplateMiddle | TemplateTail
  ts.isJsxText(n) ||
  ts.isPrivateIdentifier(n);

const childrenOf = (n: ts.Node): ts.Node[] => {
  const out: ts.Node[] = [];
  n.forEachChild((c) => {
    out.push(c);
    return undefined;
  });
  return out;
};

const parse = (name: string, text: string): ts.SourceFile =>
  ts.createSourceFile(name, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.TS);

interface RenamePair {
  readonly from: string;
  readonly to: string;
  readonly where: string;
}

export function namesOnlyDiff(oldTs: string, newTs: string): NamesDiff {
  if (oldTs === newTs) return { equalModuloNames: true, renames: NO_RENAMES };

  const sfOld = parse("old.ts", oldTs);
  const sfNew = parse("new.ts", newTs);
  const at = (sf: ts.SourceFile, n: ts.Node): string => {
    const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart(sf));
    return `${line + 1}:${character + 1}`;
  };
  const both = (a: ts.Node, b: ts.Node): string => `old ${at(sfOld, a)} / new ${at(sfNew, b)}`;
  const pairs: RenamePair[] = [];

  /** Lockstep walk; returns the first divergence, or undefined (collecting pairs). */
  const walk = (a: ts.Node, b: ts.Node, path: string): string | undefined => {
    if (a.kind !== b.kind) {
      return `${path}: ${kindName(a.kind)} (old ${at(sfOld, a)}) vs ${kindName(b.kind)} (new ${at(sfNew, b)})`;
    }
    if (ts.isIdentifier(a)) {
      const ib = b as ts.Identifier;
      const role = idRole(a);
      const roleB = idRole(ib);
      // Shape-aligned trees give positionally-paired identifiers the same role;
      // belt-and-braces for any exotic case: disagreeing roles are a divergence.
      if (role !== roleB) {
        return `${path}: identifier role ${role} ('${a.text}') vs ${roleB} ('${ib.text}') (${both(a, ib)})`;
      }
      if (role === "renameable") {
        pairs.push({ from: a.text, to: ib.text, where: both(a, ib) });
        return undefined;
      }
      if (a.text !== ib.text) {
        const what = role === "fixed-opaque" ? "property/member name" : "import/export-bound name";
        return `${path}: ${what} '${a.text}' vs '${ib.text}' (${both(a, ib)}) — not a renameable position`;
      }
      if (role === "fixed-value") pairs.push({ from: a.text, to: ib.text, where: `pinned at ${both(a, ib)}` });
      return undefined;
    }
    if (isTextCarrier(a)) {
      const ta = (a as ts.LiteralLikeNode).text;
      const tb = (b as ts.LiteralLikeNode).text;
      if (ta !== tb) {
        return `${path}: ${kindName(a.kind)} content ${JSON.stringify(ta)} vs ${JSON.stringify(tb)} (${both(a, b)})`;
      }
      return undefined;
    }
    const ca = childrenOf(a);
    const cb = childrenOf(b);
    if (ca.length !== cb.length) {
      return `${path}: ${kindName(a.kind)} has ${ca.length} children vs ${cb.length} (${both(a, b)})`;
    }
    for (let i = 0; i < ca.length; i++) {
      const d = walk(ca[i]!, cb[i]!, `${path}/${kindName(ca[i]!.kind)}[${i}]`);
      if (d !== undefined) return d;
    }
    return undefined;
  };

  const divergence = walk(sfOld, sfNew, "SourceFile");
  if (divergence !== undefined) return { equalModuloNames: false, renames: NO_RENAMES, divergence };

  // Global bijection over the collected occurrence pairs.
  const fwd = new Map<string, RenamePair>();
  const rev = new Map<string, RenamePair>();
  for (const p of pairs) {
    const f = fwd.get(p.from);
    if (f !== undefined && f.to !== p.to) {
      return {
        equalModuloNames: false,
        renames: NO_RENAMES,
        divergence: `inconsistent renaming: '${p.from}' → '${f.to}' (${f.where}) but also '${p.from}' → '${p.to}' (${p.where})`,
      };
    }
    const r = rev.get(p.to);
    if (r !== undefined && r.from !== p.from) {
      return {
        equalModuloNames: false,
        renames: NO_RENAMES,
        divergence: `name collision: '${r.from}' → '${p.to}' (${r.where}) and '${p.from}' → '${p.to}' (${p.where}) — two old names collapse into one`,
      };
    }
    if (f === undefined) fwd.set(p.from, p);
    if (r === undefined) rev.set(p.to, p);
  }
  const renames = new Map<string, string>();
  for (const [from, p] of fwd) if (from !== p.to) renames.set(from, p.to);
  return { equalModuloNames: true, renames };
}

/**
 * The regeneration-review seam: called once per emitted fixture with the
 * committed text and the regenerated text. Equal-modulo-names → returns the
 * rename table (the judge reads these tables AS the naming review); anything
 * else → throws, surfacing the first structural divergence for ordinary
 * byte-diff review. `.error.txt` door fixtures are not TS and stay on the
 * existing byte-snapshot path — this seam is for `.ts` artifacts only.
 */
export function assertFixtureNamesOnly(oldText: string, newText: string): ReadonlyMap<string, string> {
  const d = namesOnlyDiff(oldText, newText);
  if (!d.equalModuloNames) {
    throw new Error(`names-only diff: NOT equal modulo identifiers — ${d.divergence}`);
  }
  return d.renames;
}
