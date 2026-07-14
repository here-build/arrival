/**
 * Residual → TypeScript text, via `ts.factory` + the TS printer (residual-renderer.md §4,
 * constitution §3.4). The ONLY module in the system that imports `typescript` for output
 * and the only place expression/statement duality, parenthesization, and comment placement
 * are decided. Parenthesization is factory-structural — `ts.factory`'s public constructors
 * run an internal precedence-keyed parenthesizer — never string concatenation.
 *
 * Output is naive-but-correct: zero idiom optimization here (no `{x: x}` → `{x}`, no
 * single-return-block collapse) — the downstream prettier/eslint fixer tail owns idiom.
 */
import ts from "typescript";

import type { BinOp, CompilationUnit, Decl, ImportName, NodeId, Param, Pattern, R, TsType, UnOp } from "./types.js";

const f = ts.factory;

/** Internal-error surface: a violated renderer invariant. Always loud — a malformed
 *  tree must never miscompile into silently-wrong output. Carries the offending node's
 *  `origin` so a diagnostic can resolve it to a source span. */
export class ResidualRenderError extends Error {
  readonly origin?: NodeId;
  constructor(message: string, origin?: NodeId) {
    super(`residual-render internal error: ${message}`);
    this.name = "ResidualRenderError";
    this.origin = origin;
  }
}

/** JS identifier gate shared by `Member` access and `ObjectLit`/`shape` keys — the only
 *  two cleaning mechanisms for kebab-case keyword names anywhere in the pipeline: an
 *  invalid-identifier name renders as `recv["my-field"]` / `{ "max-words": v }` instead
 *  of baking unvalidated text into an Identifier (which would print `(obj.my) - field`). */
const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const BIN_TOKEN = {
  "+": ts.SyntaxKind.PlusToken,
  "-": ts.SyntaxKind.MinusToken,
  "*": ts.SyntaxKind.AsteriskToken,
  "/": ts.SyntaxKind.SlashToken,
  "%": ts.SyntaxKind.PercentToken,
  "**": ts.SyntaxKind.AsteriskAsteriskToken,
  "===": ts.SyntaxKind.EqualsEqualsEqualsToken,
  "!==": ts.SyntaxKind.ExclamationEqualsEqualsToken,
  "<": ts.SyntaxKind.LessThanToken,
  "<=": ts.SyntaxKind.LessThanEqualsToken,
  ">": ts.SyntaxKind.GreaterThanToken,
  ">=": ts.SyntaxKind.GreaterThanEqualsToken,
  "&&": ts.SyntaxKind.AmpersandAmpersandToken,
  "||": ts.SyntaxKind.BarBarToken,
  "??": ts.SyntaxKind.QuestionQuestionToken,
  "&": ts.SyntaxKind.AmpersandToken,
  "|": ts.SyntaxKind.BarToken,
  "^": ts.SyntaxKind.CaretToken,
  "<<": ts.SyntaxKind.LessThanLessThanToken,
  ">>": ts.SyntaxKind.GreaterThanGreaterThanToken,
  ">>>": ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
  in: ts.SyntaxKind.InKeyword,
  instanceof: ts.SyntaxKind.InstanceOfKeyword,
} as const satisfies Record<BinOp, ts.BinaryOperator>;

/** `typeof`/`void` are NOT `PrefixUnaryOperator` (a closed union of `++ -- + - ~ !`) —
 *  they have their own factory calls; using createPrefixUnaryExpression would not typecheck. */
const PREFIX_UN_TOKEN: Partial<Record<UnOp, ts.PrefixUnaryOperator>> = {
  "!": ts.SyntaxKind.ExclamationToken,
  "-": ts.SyntaxKind.MinusToken,
  "+": ts.SyntaxKind.PlusToken,
  "~": ts.SyntaxKind.TildeToken,
};

/**
 * Render a full compilation unit to TypeScript source text.
 *
 * Decls first, then body statements, in exactly the given order — the renderer performs
 * zero implicit reordering (§4.7 determinism; sorting is upstream's job). Printer config
 * is pinned (`newLine: LineFeed`) so the same unit yields the same bytes on any host.
 *
 * The module top level is an async-permitting boundary (the emitted artifact is ESM;
 * top-level await is legal), so a bare top-level `Await` renders without complaint.
 */
export function render(unit: CompilationUnit): string {
  const stmts = [...unit.decls.map((d) => renderDecl(d)), ...unit.body.map((s) => renderStmt(s, true))];
  const sourceFile = f.createSourceFile(stmts, f.createToken(ts.SyntaxKind.EndOfFileToken), ts.NodeFlags.None);
  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed, removeComments: false });
  return printer.printFile(sourceFile);
}

// ─── Statement position ──────────────────────────────────────────────────────────────
// `insideAsync` is the asyncness of the nearest enclosing function boundary (Arrow/FnDecl,
// or the TLA-legal module top level). It is threaded, never recomputed — the renderer only
// re-discovers verdicts Law W already minted; it never derives asyncness itself.

function renderStmt(node: R, insideAsync: boolean): ts.Statement {
  switch (node.t) {
    case "Block":
      return renderBlock(node, insideAsync);
    case "Const":
      return renderVarStmt(node.pattern, node.init, undefined, ts.NodeFlags.Const, insideAsync, node.origin);
    case "Let":
      return renderVarStmt(node.pattern, node.init, undefined, ts.NodeFlags.Let, insideAsync, node.origin);
    case "Assign":
      // Assignment is a BinaryExpression in TS's AST, not its own node kind.
      return f.createExpressionStatement(
        f.createBinaryExpression(
          renderTargetPattern(node.pattern, node.origin),
          ts.SyntaxKind.EqualsToken,
          renderExpr(node.value, insideAsync),
        ),
      );
    case "Return":
      return f.createReturnStatement(node.value === undefined ? undefined : renderExpr(node.value, insideAsync));
    case "While":
      return f.createWhileStatement(renderExpr(node.test, insideAsync), renderBlock(node.body, insideAsync));
    case "ForOf":
      return f.createForOfStatement(
        undefined,
        f.createVariableDeclarationList(
          [f.createVariableDeclaration(renderBindingPattern(node.pattern, node.origin))],
          ts.NodeFlags.Const,
        ),
        renderExpr(node.iterable, insideAsync),
        renderBlock(node.body, insideAsync),
      );
    case "Continue":
      return f.createContinueStatement(); // no label, ever — one while per named-let
    case "Throw":
      return f.createThrowStatement(renderExpr(node.value, insideAsync));
    case "Comment":
      return leadingComment(renderStmt(node.node, insideAsync), node.text);
    default:
      // Bare expression at statement position. createExpressionStatement auto-parenthesizes
      // when the leftmost leaf is an object literal / function expression (`({a: 1});`).
      return f.createExpressionStatement(renderExpr(node, insideAsync));
  }
}

function renderBlock(block: Extract<R, { t: "Block" }>, insideAsync: boolean): ts.Block {
  return f.createBlock(block.stmts.map((s) => renderStmt(s, insideAsync)), /* multiLine */ true);
}

// ─── Expression position ─────────────────────────────────────────────────────────────

function renderExpr(node: R, insideAsync: boolean): ts.Expression {
  switch (node.t) {
    case "Ref":
      return f.createIdentifier(node.binding.text);
    case "RuntimeRef":
      return f.createIdentifier(node.symbol);
    case "Lit":
      return renderLit(node);
    case "Template":
      return renderTemplate(node, insideAsync);
    case "Call":
      return f.createCallExpression(
        renderExpr(node.callee, insideAsync),
        undefined,
        node.args.map((a) => renderArg(a, insideAsync)),
      );
    case "New":
      // args is REQUIRED in the algebra: `new Foo()` (never argument-less `new Foo`),
      // which the parenthesizer then treats as a safe left-hand-side before `.prop`.
      return f.createNewExpression(
        renderExpr(node.callee, insideAsync),
        undefined,
        node.args.map((a) => renderArg(a, insideAsync)),
      );
    case "Method":
      // Desugars to Call(Member(recv, name), args) — one code path, not two. The bare
      // Member/zero-arg Method distinction stays meaningful for rule authors.
      return renderExpr({ t: "Call", callee: { t: "Member", recv: node.recv, name: node.name }, args: node.args, origin: node.origin }, insideAsync);
    case "Index":
      return f.createElementAccessExpression(renderExpr(node.recv, insideAsync), renderExpr(node.index, insideAsync));
    case "Member":
      // Identifier-validity gate: `.my-field` would parse as `(obj.my) - field` — a
      // kebab-case keyword name renders as element access instead.
      return IDENT_RE.test(node.name)
        ? f.createPropertyAccessExpression(renderExpr(node.recv, insideAsync), node.name)
        : f.createElementAccessExpression(renderExpr(node.recv, insideAsync), f.createStringLiteral(node.name));
    case "Bin":
      return f.createBinaryExpression(
        renderExpr(node.left, insideAsync),
        BIN_TOKEN[node.op],
        renderExpr(node.right, insideAsync),
      );
    case "Un": {
      if (node.op === "typeof") return f.createTypeOfExpression(renderExpr(node.arg, insideAsync));
      if (node.op === "void") return f.createVoidExpression(renderExpr(node.arg, insideAsync));
      const token = PREFIX_UN_TOKEN[node.op];
      if (token === undefined) throw new ResidualRenderError(`unknown unary operator ${node.op}`, node.origin);
      return f.createPrefixUnaryExpression(token, renderExpr(node.arg, insideAsync));
    }
    case "Cond":
      return f.createConditionalExpression(
        renderExpr(node.test, insideAsync),
        undefined,
        renderExpr(node.then, insideAsync),
        undefined,
        renderExpr(node.else, insideAsync),
      );
    case "Arrow":
      return renderArrow(node.params, node.body, node.async === true, undefined, node.origin);
    case "ArrayLit":
      return f.createArrayLiteralExpression(node.elements.map((el) => renderArg(el, insideAsync)));
    case "ObjectLit":
      return f.createObjectLiteralExpression(
        node.entries.map((e) =>
          e.kind === "spread"
            ? f.createSpreadAssignment(renderExpr(e.value, insideAsync))
            : f.createPropertyAssignment(propName(e.key), renderExpr(e.value, insideAsync)),
        ),
      );
    case "Spread":
      throw new ResidualRenderError(
        "Spread is legal only inside ArrayLit.elements / Call.args / New.args",
        node.origin,
      );
    case "Await":
      // Law W's renderer backstop: an Await whose nearest enclosing function boundary
      // is not async is an internal error — never a silently-wrong non-async emit.
      if (!insideAsync) {
        throw new ResidualRenderError("Await under a non-async function boundary", node.origin);
      }
      return f.createAwaitExpression(renderExpr(node.value, insideAsync));
    case "Block":
      return renderBlockAsIife(node, insideAsync);
    case "Comment": {
      // Type-legal, discipline-discouraged (a mid-expression floating comment): renders
      // validly rather than crashing.
      return leadingComment(renderExpr(node.node, insideAsync), node.text);
    }
    case "Annotated":
      // Legal shape (a): wraps an Arrow — the type is the arrow's RETURN type, populated
      // in the same createArrowFunction call (never patched onto a built node). Shape (b)
      // — direct init of Const/Let — is unwrapped by renderVarStmt before reaching here.
      if (node.value.t === "Arrow") {
        return renderArrow(node.value.params, node.value.body, node.value.async === true, toTypeNode(node.type), node.value.origin);
      }
      throw new ResidualRenderError(
        "Annotated has exactly two legal shapes: wrapping an Arrow, or as the direct init of a Const/Let",
        node.origin,
      );
    case "Const":
    case "Let":
    case "Assign":
    case "Return":
    case "While":
    case "ForOf":
    case "Continue":
    case "Throw":
      // Statement-only kinds with no ts.Expression encoding. Structurally unreachable
      // given the position-pinned dispatch above — asserted anyway (defense-in-depth).
      throw new ResidualRenderError(`statement-only node ${node.t} in expression position`, node.origin);
    default:
      return exhausted(node);
  }
}

/** A `Spread` node is only meaningful in argument/element slots — handled here, so the
 *  general renderExpr can reject it everywhere else. */
function renderArg(node: R, insideAsync: boolean): ts.Expression {
  return node.t === "Spread" ? f.createSpreadElement(renderExpr(node.value, insideAsync)) : renderExpr(node, insideAsync);
}

/**
 * The expression/statement duality, decided once (constitution §3.4): a Block reaching
 * expression position becomes an IIFE — async and awaited INLINE when it contains an
 * Await, plain otherwise. `containsAwait` only re-discovers Awaits Law W already minted
 * (it never descends into a nested Arrow's own boundary); the enclosing-boundary check
 * makes a sync-context async-IIFE loud instead of silently wrong.
 */
function renderBlockAsIife(block: Extract<R, { t: "Block" }>, insideAsync: boolean): ts.Expression {
  const isAsync = containsAwait(block);
  if (isAsync && !insideAsync) {
    throw new ResidualRenderError(
      "Block containing Await reached expression position under a non-async function boundary",
      block.origin,
    );
  }
  const arrow = f.createArrowFunction(
    isAsync ? [f.createToken(ts.SyntaxKind.AsyncKeyword)] : undefined,
    undefined,
    [],
    undefined,
    undefined,
    renderBlock(block, isAsync),
  );
  const call = f.createCallExpression(arrow, undefined, []);
  return isAsync ? f.createAwaitExpression(call) : call;
}

/** True iff an Await is reachable WITHOUT crossing an Arrow boundary (an inner arrow's
 *  awaits belong to its own async verdict, not this block's). */
function containsAwait(node: R): boolean {
  if (node.t === "Await") return true;
  if (node.t === "Arrow") return false;
  return rChildren(node).some(containsAwait);
}

function rChildren(node: R): readonly R[] {
  switch (node.t) {
    case "Ref":
    case "RuntimeRef":
    case "Lit":
    case "Continue":
      return [];
    case "Template":
      return node.exprs;
    case "Call":
    case "New":
      return [node.callee, ...node.args];
    case "Method":
      return [node.recv, ...node.args];
    case "Index":
      return [node.recv, node.index];
    case "Member":
      return [node.recv];
    case "Bin":
      return [node.left, node.right];
    case "Un":
      return [node.arg];
    case "Cond":
      return [node.test, node.then, node.else];
    case "Arrow":
      return [node.body];
    case "ArrayLit":
      return node.elements;
    case "ObjectLit":
      return node.entries.map((e) => e.value);
    case "Spread":
    case "Await":
    case "Throw":
      return [node.value];
    case "Block":
      return node.stmts;
    case "Const":
    case "Let":
      return [node.init];
    case "Assign":
      return [node.value];
    case "Return":
      return node.value === undefined ? [] : [node.value];
    case "While":
      return [node.test, node.body];
    case "ForOf":
      return [node.iterable, node.body];
    case "Comment":
      return [node.node];
    case "Annotated":
      return [node.value];
    default:
      return exhausted(node);
  }
}

// ─── Literals ────────────────────────────────────────────────────────────────────────

function renderLit(node: Extract<R, { t: "Lit" }>): ts.Expression {
  const v = node.value;
  switch (v.k) {
    case "string":
      return f.createStringLiteral(v.value);
    case "number":
      // createNumericLiteral ASSERTS on a leading `-`; negatives (and -0) must render as
      // prefix-minus over the absolute literal.
      return v.value < 0 || Object.is(v.value, -0)
        ? f.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, f.createNumericLiteral(String(-v.value)))
        : f.createNumericLiteral(String(v.value));
    case "bigint":
      // createBigIntLiteral has NO negative assert — a leading `-` would bake into a
      // silently-malformed node, worse than the numeric case. Same prefix-minus routing.
      return v.value < 0n
        ? f.createPrefixUnaryExpression(ts.SyntaxKind.MinusToken, f.createBigIntLiteral(`${-v.value}n`))
        : f.createBigIntLiteral(`${v.value}n`);
    case "boolean":
      return v.value ? f.createTrue() : f.createFalse();
    case "null":
      return f.createNull();
    case "undefined":
      // Bare `undefined`, not `void 0` — legibility over shadowing paranoia; the namer's
      // RESERVED set is the right place to defend (edge inventory, residual-renderer.md §5).
      return f.createIdentifier("undefined");
    default:
      return exhausted(v);
  }
}

function renderTemplate(node: Extract<R, { t: "Template" }>, insideAsync: boolean): ts.Expression {
  const { quasis, exprs } = node;
  if (quasis.length !== exprs.length + 1) {
    throw new ResidualRenderError(
      `Template arity: quasis.length (${quasis.length}) must be exprs.length+1 (${exprs.length + 1})`,
      node.origin,
    );
  }
  if (exprs.length === 0) return f.createNoSubstitutionTemplateLiteral(quasis[0]);
  const last = exprs.length - 1;
  return f.createTemplateExpression(
    f.createTemplateHead(quasis[0]),
    exprs.map((e, i) =>
      f.createTemplateSpan(
        renderExpr(e, insideAsync),
        i === last ? f.createTemplateTail(quasis[i + 1]) : f.createTemplateMiddle(quasis[i + 1]),
      ),
    ),
  );
}

// ─── Patterns: binding position vs target position ──────────────────────────────────
// One Pattern type, two structurally different renderings gated on which field it was
// found in — never guessed from shape. Getting this wrong is a silent AST bug:
// ArrayBindingPattern is not an Expression and cannot sit on a BinaryExpression's left.

/** Binding position (Const/Let/ForOf patterns, ArrayPattern elements). RestBinding is a
 *  slot modifier (dotDotDotToken), not a wrapper node — handled by the slot owners
 *  (paramDecl / bindingElement), so a bare RestBinding here is a misplaced rest. */
function renderBindingPattern(pattern: Pattern, origin: NodeId | undefined): ts.BindingName {
  switch (pattern.t) {
    case "Binding":
      return f.createIdentifier(pattern.text);
    case "ArrayPattern":
      return f.createArrayBindingPattern(pattern.elements.map((el, i) => bindingElement(el, i === pattern.elements.length - 1, origin)));
    case "RestBinding":
      throw new ResidualRenderError(
        "RestBinding is legal only as the last element of an ArrayPattern or the last Param's pattern",
        origin,
      );
    default:
      return exhausted(pattern);
  }
}

function bindingElement(pattern: Pattern, isLast: boolean, origin: NodeId | undefined): ts.BindingElement {
  if (pattern.t === "RestBinding") {
    if (!isLast) {
      throw new ResidualRenderError("RestBinding must be the last element of an ArrayPattern", origin);
    }
    return f.createBindingElement(f.createToken(ts.SyntaxKind.DotDotDotToken), undefined, f.createIdentifier(pattern.binding.text));
  }
  return f.createBindingElement(undefined, undefined, renderBindingPattern(pattern, origin));
}

/** Target position (Assign.pattern — the TCO simultaneous-reassignment case): an
 *  ArrayPattern renders as a plain ARRAY LITERAL used as an assignment target
 *  (`[a, b] = [x, y]`). No RestBinding in target position — the TCO rewrite is always a
 *  same-arity swap. */
function renderTargetPattern(pattern: Pattern, origin: NodeId | undefined): ts.Expression {
  switch (pattern.t) {
    case "Binding":
      return f.createIdentifier(pattern.text);
    case "ArrayPattern":
      return f.createArrayLiteralExpression(pattern.elements.map((el) => renderTargetPattern(el, origin)));
    case "RestBinding":
      throw new ResidualRenderError("RestBinding has no target-position rendering", origin);
    default:
      return exhausted(pattern);
  }
}

// ─── Functions ───────────────────────────────────────────────────────────────────────

function renderArrow(
  params: readonly Param[],
  body: R,
  isAsync: boolean,
  returnType: ts.TypeNode | undefined,
  origin: NodeId | undefined,
): ts.ArrowFunction {
  // Arrow.body is position-polymorphic input: a Block renders as the literal function
  // body (no IIFE-then-unwrap dance); anything else is a concise expression body —
  // createArrowFunction itself parenthesizes an object-literal concise body.
  const bodyNode: ts.ConciseBody = body.t === "Block" ? renderBlock(body, isAsync) : renderExpr(body, isAsync);
  return f.createArrowFunction(
    isAsync ? [f.createToken(ts.SyntaxKind.AsyncKeyword)] : undefined,
    undefined,
    renderParams(params, origin),
    returnType,
    undefined,
    bodyNode,
  );
}

function renderParams(params: readonly Param[], origin: NodeId | undefined): ts.ParameterDeclaration[] {
  return params.map((p, i) => paramDecl(p, i === params.length - 1, origin));
}

function paramDecl(param: Param, isLast: boolean, origin: NodeId | undefined): ts.ParameterDeclaration {
  const typeNode = param.type === undefined ? undefined : toTypeNode(param.type);
  if (param.pattern.t === "RestBinding") {
    if (!isLast) {
      throw new ResidualRenderError("RestBinding must be the last Param's pattern", origin);
    }
    // The renderer attaches whatever TsType it is handed — a rest param's array-ness is
    // the constructor's responsibility, per the zero-idiom-inference discipline.
    return f.createParameterDeclaration(
      undefined,
      f.createToken(ts.SyntaxKind.DotDotDotToken),
      f.createIdentifier(param.pattern.binding.text),
      undefined,
      typeNode,
      undefined,
    );
  }
  return f.createParameterDeclaration(
    undefined,
    undefined,
    renderBindingPattern(param.pattern, origin),
    undefined,
    typeNode,
    undefined,
  );
}

// ─── Variable statements (Const / Let / ConstDecl) ───────────────────────────────────

function renderVarStmt(
  pattern: Pattern,
  init: R,
  declaredType: TsType | undefined,
  flags: ts.NodeFlags,
  insideAsync: boolean,
  origin: NodeId | undefined,
): ts.VariableStatement {
  let typeNode = declaredType === undefined ? undefined : toTypeNode(declaredType);
  let initR = init;
  // Annotated legal shape (b): as the DIRECT init of a Const/Let, the annotation becomes
  // the variable declaration's own type. An Annotated(Arrow) init instead takes shape (a)
  // (arrow return type) via renderExpr — the two shapes never compete for the same slot.
  if (initR.t === "Annotated" && initR.value.t !== "Arrow") {
    typeNode = toTypeNode(initR.type);
    initR = initR.value;
  }
  return f.createVariableStatement(
    undefined,
    f.createVariableDeclarationList(
      [f.createVariableDeclaration(renderBindingPattern(pattern, origin), undefined, typeNode, renderExpr(initR, insideAsync))],
      flags,
    ),
  );
}

// ─── Types (TsType → ts.TypeNode) ────────────────────────────────────────────────────

function toTypeNode(t: TsType): ts.TypeNode {
  switch (t.k) {
    case "unknown":
      return f.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword);
    case "prim":
      switch (t.name) {
        case "number":
          return f.createKeywordTypeNode(ts.SyntaxKind.NumberKeyword);
        case "string":
          return f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword);
        case "boolean":
          return f.createKeywordTypeNode(ts.SyntaxKind.BooleanKeyword);
        case "bigint":
          return f.createKeywordTypeNode(ts.SyntaxKind.BigIntKeyword);
        case "void":
          return f.createKeywordTypeNode(ts.SyntaxKind.VoidKeyword);
        default:
          return exhausted(t);
      }
    case "array":
      return f.createArrayTypeNode(toTypeNode(t.el));
    case "shape":
      // Ordered tuples in, ordered members out — determinism by construction (§4.7).
      return f.createTypeLiteralNode(
        t.fields.map(([key, value]) => f.createPropertySignature(undefined, propName(key), undefined, toTypeNode(value))),
      );
    case "ref":
      return f.createTypeReferenceNode(t.name, t.args?.map(toTypeNode));
    case "union":
      return f.createUnionTypeNode(t.members.map(toTypeNode)); // pre-sorted upstream
    default:
      return exhausted(t);
  }
}

// ─── The declaration layer ───────────────────────────────────────────────────────────

function renderDecl(decl: Decl): ts.Statement {
  switch (decl.t) {
    case "FnDecl": {
      // FnDecl exists for HOISTING (the self-hosted preamble's mutual recursion);
      // user-program defines emit ConstDecl. Which one a define becomes is upstream's call.
      const isAsync = decl.async === true;
      return f.createFunctionDeclaration(
        isAsync ? [f.createToken(ts.SyntaxKind.AsyncKeyword)] : undefined,
        undefined,
        f.createIdentifier(decl.name.text),
        undefined,
        renderParams(decl.params, decl.origin),
        decl.returnType === undefined ? undefined : toTypeNode(decl.returnType),
        renderBlock(decl.body, isAsync),
      );
    }
    case "ConstDecl":
      return renderVarStmt(decl.name, decl.init, decl.type, ts.NodeFlags.Const, true, decl.origin);
    case "Import":
      return importDecl(decl.names, decl.from, undefined);
    case "ImportType":
      // The clause's REAL type-only flag (phase modifier) — never a "type " string
      // smuggled into a name.
      return importDecl(decl.names, decl.from, ts.SyntaxKind.TypeKeyword);
    case "Export":
      return f.createExportDeclaration(
        undefined,
        false,
        f.createNamedExports(decl.names.map((n) => f.createExportSpecifier(false, undefined, n))),
        undefined,
      );
    case "DeclComment":
      return leadingComment(renderDecl(decl.decl), decl.text);
    default:
      return exhausted(decl);
  }
}

function importDecl(
  names: readonly ImportName[],
  from: string,
  phaseModifier: ts.ImportPhaseModifierSyntaxKind | undefined,
): ts.ImportDeclaration {
  return f.createImportDeclaration(
    undefined,
    f.createImportClause(
      phaseModifier,
      undefined,
      f.createNamedImports(
        names.map((n) =>
          n.local === undefined
            ? f.createImportSpecifier(false, undefined, f.createIdentifier(n.imported))
            : f.createImportSpecifier(false, f.createIdentifier(n.imported), f.createIdentifier(n.local)),
        ),
      ),
    ),
    f.createStringLiteral(from),
  );
}

// ─── Shared helpers ──────────────────────────────────────────────────────────────────

/** ObjectLit/`shape` key gate — mirror of the Member gate: createPropertyAssignment's
 *  string overload bakes UNVALIDATED text into an Identifier, so a kebab-case key must
 *  pre-route to a string literal (`{ "max-words": v }`). */
function propName(key: string): ts.PropertyName {
  return IDENT_RE.test(key) ? f.createIdentifier(key) : f.createStringLiteral(key);
}

/** One comment convention for both layers (Comment / DeclComment): a LEADING block
 *  comment (MultiLineCommentTrivia), never trailing (trailing attachment + prettier
 *  relocation is a known weird-output source). Text passes through verbatim — the
 *  renderer adds no padding, per the zero-idiom discipline. */
function leadingComment<T extends ts.Node>(rendered: T, text: string): T {
  return ts.addSyntheticLeadingComment(rendered, ts.SyntaxKind.MultiLineCommentTrivia, text, true);
}

function exhausted(x: never): never {
  throw new ResidualRenderError(`unhandled node kind ${JSON.stringify(x)}`);
}
