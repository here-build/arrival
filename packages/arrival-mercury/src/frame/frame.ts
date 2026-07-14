/**
 * MINIMAL FRAME — the frame-as-query import materializer (constitution §3.4:
 * "`RuntimeRef(symbol)` is the frame-as-query mechanism… FRAME scans the finished
 * tree once and materializes exactly the imports that occur"; §9 Phase 1 pins this
 * minimal form — the full FRAME that owns decls/exports/dead-defines is Phase 3).
 *
 * One scan of the FINISHED tree (post-walk, post-ASYNC-IFY — the pass order matters:
 * ASYNC-IFY seeds key `RuntimeRef` symbols, so FRAME's rewrite must run after it):
 *
 *   1. census — `runtimeRefsOf(unit)`, then **sorted** (UTF-16 code-unit order, the
 *      §8 determinism convention) — first-occurrence order was the alternative and
 *      loses: an upstream rule reordering its operands would silently reorder the
 *      import list;
 *   2. resolve — every census symbol maps through the manifest (symbol → the runtime
 *      module's SAFE exported name; scheme names like `eq?`/`>` are not JS
 *      identifiers, so the runtime exports `eqP`/`gt` and the manifest is the one
 *      shared naming authority). A symbol without a manifest row **doors** —
 *      collect-all, one teaching throw (silence is impossible; a raw identifier
 *      would be invalid JS or a phantom global);
 *   3. alias — each import's LOCAL name avoids every binding text occurring anywhere
 *      in the unit (module-scope imports are visible everywhere, and the walker's
 *      namer minted its names with no knowledge of them — a nested user binding
 *      sharing the text would silently shadow the import), `_2`-suffixing on
 *      collision exactly like the walker's own ladder;
 *   4. rewrite — every `RuntimeRef` node becomes `Ref(localBinding)`, so the
 *      renderer stays dumb (it keeps rendering `RuntimeRef` as the raw symbol —
 *      after FRAME none survive; the raw-symbol rendering remains only as the
 *      pre-FRAME debugging view);
 *   5. prepend ONE `Import` decl carrying the whole name list.
 *
 * Identity fast-path: a unit with an empty census is returned unchanged (the same
 * contract asyncIfy keeps — pure input, same reference when there is nothing to do).
 */
import type { CompilationUnit, Decl, ImportName, Pattern, R } from "../residual/types.js";
import { Binding as mkBinding, Import, type Binding } from "../residual/types.js";
import { STAGE0 } from "../runtime/stage0.js";
import { runtimeRefsOf } from "../walker/index.js";

export interface FrameOptions {
  /** The import specifier the emitted module uses for the runtime module (the
   *  oracle harness stages `stage0` into the scratch dir and passes `"./stage0.mts"`;
   *  a real emitted project passes its own runtime path). */
  readonly runtimeModule: string;
  /** symbol → exported-name manifest; defaults to the stage-0 manifest. Override
   *  seam for tests and for later runtime stages. */
  readonly manifest?: Readonly<Record<string, string>>;
}

/** The frame's compile-time refusal (the FRAME twin of `WalkDoorError` /
 *  `AsyncIfyDoorError`): a `RuntimeRef` whose symbol the runtime module does not
 *  export cannot ship — the emitted import would fail at load time, far from the
 *  cause. Message includes "not supported" so the oracle's compiled-side classifier
 *  files it as `unsupported-form` (the door-code contract's phrasing seam). */
export class FrameDoorError extends Error {
  readonly symbols: readonly string[];
  constructor(symbols: readonly string[]) {
    super(
      `frame door: ${symbols.map((s) => `\`${s}\``).join(", ")} ${symbols.length === 1 ? "is" : "are"} ` +
        `not supported by the runtime module yet — no manifest export exists. Add the shim + its STAGE0 ` +
        `manifest row in src/runtime/stage0.ts (constitution §4.4; the export set grows corpus-driven).`,
    );
    this.name = "FrameDoorError";
    this.symbols = symbols;
  }
}

type BlockR = Extract<R, { t: "Block" }>;

/** Every JS name already spoken for anywhere in the unit — declaration AND reference
 *  positions. References matter too: `Ref(Binding("Math"))` (the quotient rule) and
 *  `Ref(Binding("Promise"))` (ASYNC-IFY) are global reads an import local must not
 *  capture. Over-approximation is free — a skipped candidate only costs a `_2`. */
function takenNamesOf(unit: CompilationUnit): Set<string> {
  const out = new Set<string>();
  const pat = (p: Pattern): void => {
    if (p.t === "Binding") out.add(p.text);
    else if (p.t === "RestBinding") out.add(p.binding.text);
    else p.elements.forEach(pat);
  };
  const visit = (n: R): void => {
    switch (n.t) {
      case "Ref":
        out.add(n.binding.text);
        return;
      case "Arrow":
        for (const p of n.params) pat(p.pattern);
        visit(n.body);
        return;
      case "Const":
      case "Let":
      case "Assign":
        pat(n.pattern);
        visit(n.t === "Assign" ? n.value : n.init);
        return;
      case "ForOf":
        pat(n.pattern);
        visit(n.iterable);
        visit(n.body);
        return;
      default:
        for (const c of childrenOf(n)) visit(c);
    }
  };
  const visitDecl = (d: Decl): void => {
    switch (d.t) {
      case "FnDecl":
        out.add(d.name.text);
        for (const p of d.params) pat(p.pattern);
        visit(d.body);
        return;
      case "ConstDecl":
        out.add(d.name.text);
        visit(d.init);
        return;
      case "DeclComment":
        visitDecl(d.decl);
        return;
      case "Import":
      case "ImportType":
        for (const n of d.names) out.add(n.local ?? n.imported);
        return;
      case "Export":
        return;
    }
  };
  for (const d of unit.decls) visitDecl(d);
  for (const s of unit.body) visit(s);
  return out;
}

/**
 * Materialize the unit's runtime imports. Pure — the input is never mutated; an
 * empty census returns the SAME reference.
 */
export function frame(unit: CompilationUnit, opts: FrameOptions): CompilationUnit {
  const census = runtimeRefsOf(unit);
  if (census.size === 0) return unit;
  const manifest = opts.manifest ?? STAGE0;

  const symbols = [...census].sort(); // UTF-16 code-unit order — the §8 determinism convention
  const missing = symbols.filter((s) => manifest[s] === undefined);
  if (missing.length > 0) throw new FrameDoorError(missing);

  const taken = takenNamesOf(unit);
  const aliasOf = new Map<string, Binding>();
  const names: ImportName[] = symbols.map((symbol) => {
    const exported = manifest[symbol]!;
    let local = exported;
    for (let n = 2; taken.has(local); n++) local = `${exported}_${n}`;
    taken.add(local);
    aliasOf.set(symbol, mkBinding(local));
    return local === exported ? { imported: exported } : { imported: exported, local };
  });

  const rewriteBlock = (b: BlockR): BlockR => ({ ...b, stmts: b.stmts.map(rewrite) });
  const rewrite = (n: R): R => {
    switch (n.t) {
      case "RuntimeRef": {
        // Census-complete by construction: every RuntimeRef symbol is in `aliasOf`.
        return { t: "Ref", binding: aliasOf.get(n.symbol)!, origin: n.origin };
      }
      case "Ref":
      case "Lit":
      case "Continue":
        return n;
      case "Template":
        return { ...n, exprs: n.exprs.map(rewrite) };
      case "Call":
      case "New":
        return { ...n, callee: rewrite(n.callee), args: n.args.map(rewrite) };
      case "Method":
        return { ...n, recv: rewrite(n.recv), args: n.args.map(rewrite) };
      case "Index":
        return { ...n, recv: rewrite(n.recv), index: rewrite(n.index) };
      case "Member":
        return { ...n, recv: rewrite(n.recv) };
      case "Bin":
        return { ...n, left: rewrite(n.left), right: rewrite(n.right) };
      case "Un":
        return { ...n, arg: rewrite(n.arg) };
      case "Cond":
        return { ...n, test: rewrite(n.test), then: rewrite(n.then), else: rewrite(n.else) };
      case "Arrow":
        return { ...n, body: rewrite(n.body) };
      case "ArrayLit":
        return { ...n, elements: n.elements.map(rewrite) };
      case "ObjectLit":
        return { ...n, entries: n.entries.map((e) => ({ ...e, value: rewrite(e.value) })) };
      case "Spread":
      case "Await":
      case "Throw":
        return { ...n, value: rewrite(n.value) };
      case "Block":
        return rewriteBlock(n);
      case "Const":
      case "Let":
        return { ...n, init: rewrite(n.init) };
      case "Assign":
        return { ...n, value: rewrite(n.value) };
      case "Return":
        return n.value === undefined ? n : { ...n, value: rewrite(n.value) };
      case "While":
        return { ...n, test: rewrite(n.test), body: rewriteBlock(n.body) };
      case "ForOf":
        return { ...n, iterable: rewrite(n.iterable), body: rewriteBlock(n.body) };
      case "If":
        return {
          ...n,
          test: rewrite(n.test),
          then: rewriteBlock(n.then),
          else: n.else === undefined ? undefined : rewrite(n.else),
        };
      case "Comment":
        return { ...n, node: rewrite(n.node) };
      case "Annotated":
        return { ...n, value: rewrite(n.value) };
    }
  };
  const rewriteDecl = (d: Decl): Decl => {
    switch (d.t) {
      case "FnDecl":
        return { ...d, body: rewriteBlock(d.body) };
      case "ConstDecl":
        return { ...d, init: rewrite(d.init) };
      case "DeclComment":
        return { ...d, decl: rewriteDecl(d.decl) };
      case "Import":
      case "ImportType":
      case "Export":
        return d;
    }
  };

  return {
    decls: [Import(names, opts.runtimeModule), ...unit.decls.map(rewriteDecl)],
    body: unit.body.map(rewrite),
  };
}

/** Structural children for the name census — the third sibling of the renderer's
 *  `rChildren` and ASYNC-IFY's `childrenOf` (each module keeps its own: the three
 *  passes evolve independently and a shared visitor would couple them; candidates
 *  for extraction only when a fourth appears). Pattern-carrying kinds are handled
 *  explicitly in `takenNamesOf` before this fallback. */
function childrenOf(node: R): readonly R[] {
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
    case "If":
      return node.else === undefined ? [node.test, node.then] : [node.test, node.then, node.else];
    case "Comment":
      return [node.node];
    case "Annotated":
      return [node.value];
  }
}
