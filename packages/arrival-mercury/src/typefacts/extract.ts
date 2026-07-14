/**
 * typefacts/extract — `extractFacts`: CoreForm program × virtual TS → the
 * per-node fact table (typefacts-extraction.md, reconciled against constitution
 * §3.3/§5.3).
 *
 * ── The span → NodeId join ────────────────────────────────────────────────────
 * Both sides key on byte spans into the SAME source text: classify() copies
 * parser spans onto CoreForm nodes verbatim, and type-emit records one mapping
 * per emitted node carrying that node's span. Representation therefore ⇔ exact
 * span equality, and the join is:
 *
 *   1. EXACT scheme-span match (node.span ≡ mapping's scheme range), with the
 *      OWNERSHIP guard: spans can collide — a classification/desugar-synthesized
 *      node INHERITS its nearest enclosing real node's span (coreform types.ts)
 *      — so a span's facts attach only to the OUTERMOST carrier (minimum NodeId:
 *      ids are pre-order, and the real owner is an ancestor of every inheritor).
 *      A queried non-owner holes as "unmapped-span" — the emitter recorded
 *      nothing FOR IT.
 *   2. TS-side CONTAINMENT: the mapped ts range selects the TIGHTEST TS node
 *      covering the WHOLE range (never a sub-token — an exact whole-form mapping
 *      resolves to the call expression, not its `__arr` head; a wrapped
 *      condition resolves to the INNER pre-`__scmTruth` expression because the
 *      wrapper records no span of its own — spec §8 item 3's high-stakes
 *      sub-assumption, probe-verified).
 *   3. Several exact mappings for one span (desugar duplication): derive at
 *      each; identical facts pass, divergence refuses as "ambiguous-span".
 *
 * A scheme-side positional fallback (project an offset into a WIDER containing
 * mapping, Mapper.toTs-style) is deliberately ABSENT: with per-node exact
 * recording on both sides, a containing mapping can only ever attach an
 * enclosing or sibling expression's type to the node — wrong-and-confident, the
 * one failure direction Law F ranks below every hole. Cursor-style projection is
 * an IDE affordance (span-map.ts), not extraction evidence.
 *
 * ── Flow-sensitivity ─────────────────────────────────────────────────────────
 * Facts are read at each occurrence's own mapping (per-occurrence, spec §5):
 * distinct Ref occurrences carry distinct spans, so tsc's control-flow type at
 * that exact position is what lands in the table. Permanence is a property of
 * the proof, not the binding (§2.2) — there is no per-binding cache here.
 */
import ts from "typescript";

import { classify } from "../coreform/index.js";
import type { ClassifyResult, CoreForm, NodeId, Span } from "../coreform/index.js";
import { desugar } from "../front/desugar.js";
import { parseSexprs } from "../front/parse.js";
import { emitTypes, type Mapping } from "../type-emit/index.js";
import { callableClaim, deriveFacts, litFacts, quoteFacts, type DeriveContext } from "./derive.js";
import {
  type ClassifiedSource,
  type ExtractFactsOptions,
  type FactsExtraction,
  hasFacts,
  type HoleReason,
  type TypeFacts,
} from "./facts.js";
import { createFactsProgram, PRELUDE_FILE, tightestCovering } from "./lens-program.js";

const ANY_OR_UNKNOWN = ts.TypeFlags.Any | ts.TypeFlags.Unknown;

/** Queried kinds (spec §3's table): Ref occurrences and the application/
 *  condition expressions. Lit/Quote derive structurally (no query); binding
 *  forms, lambdas, dicts and doors carry no vocabulary v1. */
type QueriedKind = "Ref" | "App" | "And" | "Or" | "If";
const QUERIED: ReadonlySet<string> = new Set(["Ref", "App", "And", "Or", "If"] satisfies QueriedKind[]);

interface WalkEntry {
  readonly node: CoreForm;
  /** This node sits in an App's positionalArgs — the value-position probe's
   *  eligibility (spec §3: instantiated signature at the use site). */
  readonly inAppArg: boolean;
  /** This node is an App's `fn` — operator position (skipped for Refs: builtin
   *  heads lower to `__arr` members with no own atom emission; the call itself
   *  is the App's row). */
  readonly inAppFn: boolean;
  /** Index of the enclosing top-level form — droppedForms alignment (E2). */
  readonly topIndex: number;
}

interface Walked {
  readonly entries: WalkEntry[];
  /** span key → minimum NodeId over EVERY id-carrying record (CoreForm nodes +
   *  Param/Binding/KwEntry records) — the ownership table for inherited spans. */
  readonly spanOwner: Map<string, NodeId>;
}

const keyOf = (s: Span): string => `${s[0]}:${s[1]}`;

function walkProgram(classified: ClassifyResult): Walked {
  const entries: WalkEntry[] = [];
  const spanOwner = new Map<string, NodeId>();
  const own = (id: NodeId, span: Span): void => {
    const k = keyOf(span);
    const prev = spanOwner.get(k);
    if (prev === undefined || id < prev) spanOwner.set(k, id);
  };

  const visit = (node: CoreForm, inAppArg: boolean, inAppFn: boolean, topIndex: number): void => {
    own(node.id, node.span);
    entries.push({ node, inAppArg, inAppFn, topIndex });
    const child = (c: CoreForm, arg = false, fnPos = false): void => visit(c, arg, fnPos, topIndex);
    switch (node.kind) {
      case "Define":
        child(node.value);
        if (node.overridableType) child(node.overridableType);
        break;
      case "DefineFn":
        for (const p of node.params) own(p.id, p.span);
        for (const f of node.body) child(f);
        break;
      case "Lambda":
        for (const p of node.params) own(p.id, p.span);
        for (const f of node.body) child(f);
        break;
      case "If":
        child(node.cond);
        child(node.then);
        child(node.else);
        break;
      case "And":
      case "Or":
        for (const a of node.args) child(a);
        break;
      case "Let":
      case "NamedLet":
        for (const b of node.bindings) {
          own(b.id, b.span);
          child(b.init);
        }
        for (const f of node.body) child(f);
        break;
      case "Begin":
        for (const f of node.body) child(f);
        break;
      case "App":
        child(node.fn, false, true);
        for (const a of node.positionalArgs) child(a, true);
        for (const kw of node.kwargs) {
          own(kw.id, kw.span);
          child(kw.value);
        }
        break;
      case "Dict":
        for (const e of node.entries) {
          own(e.id, e.span);
          child(e.value);
        }
        break;
      default:
        // Ref | Lit | Quote | Require | Door — leaves.
        break;
    }
  };

  for (const [topIndex, form] of classified.forms.entries()) visit(form, false, false, topIndex);
  return { entries, spanOwner };
}

/** Exact-span mapping index, deduplicated on identical (tsStart, tsLength). */
function indexMappings(mappings: readonly Mapping[]): Map<string, Mapping[]> {
  const bySpan = new Map<string, Mapping[]>();
  for (const m of mappings) {
    const k = `${m.schemeStart}:${m.schemeStart + m.schemeLength}`;
    const bucket = bySpan.get(k);
    if (!bucket) {
      bySpan.set(k, [m]);
    } else if (!bucket.some((b) => b.tsStart === m.tsStart && b.tsLength === m.tsLength)) {
      bucket.push(m);
    }
  }
  return bySpan;
}

/**
 * The instantiated-signature probe (spec §4) for a Ref in argument position.
 *
 * Empirically verified (2026-07-14, tsc 6.0.2, this repo's prelude): for
 * `(map car xs)` → `__arr.map(car, xs)` — `car` a FREE identifier, since
 * value-position lowering has not landed (spec §4's flagged prerequisite) —
 * `getContextualType` ALREADY delivers `(a: number) => unknown` with the param
 * side instantiated from `xs`'s element type. The probe is positional, not
 * resolution-dependent, so the prerequisite gap costs the identifier's OWN type
 * (`any` — no base facts), not the slot's expected type — and eta needs the
 * slot ("what the slot demands, not what the symbol offers"). The secondary
 * `getResolvedSignature` path agrees on the same shape.
 */
function probeCallable(expr: ts.Expression, dctx: DeriveContext): TypeFacts["callable"] | undefined {
  const { checker } = dctx;
  const contextual = checker.getContextualType(expr);
  if (contextual && !(contextual.flags & ANY_OR_UNKNOWN)) {
    const callable = callableClaim(contextual, dctx, 0);
    if (callable) return callable;
  }
  // Secondary probe: the enclosing call's RESOLVED (post-inference) signature,
  // for contexts where contextual typing declines (overloaded heads).
  const call = expr.parent;
  if (!call || !ts.isCallExpression(call)) return undefined;
  const argIndex = call.arguments.indexOf(expr);
  if (argIndex < 0) return undefined;
  const sig = checker.getResolvedSignature(call);
  // Rest-parameter slots are not mapped 1:1 — skip rather than guess.
  const param = sig && argIndex < sig.parameters.length ? sig.parameters[argIndex] : undefined;
  if (!sig || !param) return undefined;
  const pt = checker.getTypeOfSymbolAtLocation(param, call);
  if (pt.flags & ANY_OR_UNKNOWN) return undefined;
  return callableClaim(pt, { ...dctx, atNode: call }, 0);
}

const EMPTY_EXTRACTION = (virtualTs: string): FactsExtraction => ({
  facts: new Map(),
  holes: new Map(),
  parseFailure: true,
  classified: null,
  virtualTs,
});

/**
 * Extract the per-node fact table for a program.
 *
 * Accepts the raw `.scm` text, or `{ source, classified }` to reuse an existing
 * classification (ids in the result then key into THAT classification). One
 * LanguageService program is built per call (spec Q4's sanctioned v1 cost —
 * batching is the later optimization). Law F end to end: every failure class
 * lands as a hole (see `HoleReason`), never a wrong fact.
 */
export function extractFacts(input: string | ClassifiedSource, opts?: ExtractFactsOptions): FactsExtraction {
  let source: string;
  let classified: ClassifyResult;
  if (typeof input === "string") {
    source = input;
    try {
      classified = classify(desugar(parseSexprs(source)));
    } catch {
      // E3: whole-program parse failure — no NodeIds exist; guarded-everywhere.
      return EMPTY_EXTRACTION("export {};\n");
    }
  } else {
    ({ source, classified } = input);
  }

  // The same source string re-parses inside emitTypes (its own desugar run is
  // deterministic, so spans agree with classify's); a parse that survived above
  // cannot fail here, and the classified path degrades to the empty module —
  // every queried node then holes as "unmapped-span" (Law F, not a throw).
  const emitted = emitTypes(source, { narrowsMembers: opts?.narrowsMembers, hostMembers: opts?.hostMembers });
  const { checker, sourceFile } = createFactsProgram(emitted.ts);
  const { entries, spanOwner } = walkProgram(classified);
  const bySpan = indexMappings(emitted.mappings);
  const droppedTop = new Set(emitted.droppedForms);

  const facts = new Map<NodeId, TypeFacts>();
  const holes = new Map<NodeId, HoleReason>();

  for (const { node, inAppArg, inAppFn, topIndex } of entries) {
    // Structural rows — exact by construction, independent of the emission
    // (probe-verified strictly more precise than querying the widened literal).
    if (node.kind === "Lit") {
      const f = litFacts(node.value);
      if (hasFacts(f)) facts.set(node.id, f);
      continue;
    }
    if (node.kind === "Quote") {
      const f = quoteFacts(node.datum);
      if (hasFacts(f)) facts.set(node.id, f);
      continue;
    }
    if (!QUERIED.has(node.kind)) continue;
    // Operator-position Refs are the App's row (builtin heads lower to `__arr`
    // members with no own atom emission — a per-head hole would only pollute
    // the Gate-1 histogram).
    if (node.kind === "Ref" && inAppFn) continue;

    if (droppedTop.has(topIndex)) {
      holes.set(node.id, "dropped-form");
      continue;
    }
    const spanKey = keyOf(node.span);
    if (spanOwner.get(spanKey) !== node.id) {
      // An inherited span — the mapping belongs to the outermost carrier.
      holes.set(node.id, "unmapped-span");
      continue;
    }
    const mappings = bySpan.get(spanKey);
    if (!mappings || mappings.length === 0) {
      holes.set(node.id, "unmapped-span");
      continue;
    }

    const derived: (TypeFacts | null)[] = [];
    let sawNoTsNode = false;
    for (const m of mappings) {
      const tsNode = tightestCovering(sourceFile, m.tsStart, m.tsStart + m.tsLength);
      if (!tsNode) {
        sawNoTsNode = true;
        derived.push(null);
        continue;
      }
      const dctx: DeriveContext = { checker, atNode: tsNode, preludeFile: PRELUDE_FILE };
      const type = checker.getTypeAtLocation(tsNode);
      let base = type.flags & ANY_OR_UNKNOWN ? null : deriveFacts(type, dctx, 0);
      // Value-position probe — single-occurrence Refs in argument position.
      if (node.kind === "Ref" && inAppArg && mappings.length === 1 && ts.isExpression(tsNode)) {
        const callable = probeCallable(tsNode, dctx);
        if (callable) base = { ...(base ?? {}), callable };
      }
      derived.push(base);
    }

    const first = derived[0] ?? null;
    if (derived.some((d) => d === null)) {
      if (derived.every((d) => d === null)) {
        holes.set(
          node.id,
          sawNoTsNode ? "no-ts-node" : node.kind === "Ref" && inAppArg ? "probe-miss" : "any-or-unknown",
        );
      } else {
        holes.set(node.id, "ambiguous-span"); // some emissions proved, some didn't — refuse
      }
      continue;
    }
    if (derived.length > 1 && derived.some((d) => JSON.stringify(d) !== JSON.stringify(first))) {
      holes.set(node.id, "ambiguous-span");
      continue;
    }
    if (first && hasFacts(first)) facts.set(node.id, first);
    // Proven type, silent vocabulary → neither fact nor hole.
  }

  return { facts, holes, parseFailure: false, classified, virtualTs: emitted.ts };
}
