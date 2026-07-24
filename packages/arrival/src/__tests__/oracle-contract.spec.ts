// oracle-contract.spec.ts — Track O / node O0: the shared conformance corpus + contract harness.
//
// This is the executable definition of "arrival's Layer-S oracle conforms to the constraint-kernel
// contract." It scans EVERY PREFIX of a corpus of real scout programs (valid / truncated /
// misnested / mid-token) and asserts:
//
//   1. arrival's structural reader (src/oracle/scanner.ts) AGREES with the canonical S-only
//      reference reader (sift/src/sampler/prefix-oracle.ts) on every shared structural field;
//   2. feasible() matches the reference's structural feasibility (no over-close);
//   3. the resumable session and from-scratch analyze AGREE on every prefix (the property the
//      integration plan §A1 names as the acceptance gate for Layer S);
//   4. the char-vs-token gap case: feasible(acceptedPrefix + candidateTokenString) on a mid-symbol
//      prefix like "(net" — structurally possible because the token completes some valid program.
//
// === Why the reference reader is INLINED here, not imported from sift ===
//
// arrival-scheme is a FOUNDATION package; sift (`@sift/membrane`) depends on it, not vice versa.
// `@sift/membrane` is not resolvable from this package, and a relative `../../../../../sift/...`
// import would couple a foundation's test suite to a sibling app's source tree (a layering
// violation). So the canonical S-only reference (`analyzePrefix` from sift's prefix-oracle.ts) is
// reproduced here VERBATIM, attributed below. The corpus is the single-sourced bridge: if sift's
// reference and this inlined copy ever drift, the fix is to re-sync this block from prefix-oracle.ts.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { scan, structuralScanner, makeOracle, makeOracleEnv } from "../oracle/index.js";
import { AmbientRuntime, mintFrame, mintPlainFrame } from "../env/AmbientRuntime.js";
import type { AmbientValue } from "../env/AmbientRuntime.js";

// ---------------------------------------------------------------------------------------------
// CANONICAL REFERENCE — verbatim copy of sift/src/sampler/prefix-oracle.ts `analyzePrefix`.
// Do not edit independently; re-sync from prefix-oracle.ts if that file changes.
// ---------------------------------------------------------------------------------------------
interface RefState {
  depth: number;
  inString: boolean;
  inComment: boolean;
  midToken: boolean;
  position: "top" | "operator" | "argument";
  closeable: boolean;
  closeSuffix: string;
  overClosed: boolean;
}
const REF_OPEN = new Set(["(", "[", "{"]);
const REF_CLOSE = new Set([")", "]", "}"]);
function refAnalyze(src: string): RefState {
  const elems: number[] = [];
  let depth = 0;
  let min = 0;
  let inString = false;
  let inComment = false;
  let blockComment = 0;
  let esc = false;
  let midToken = false;
  const completeToken = () => {
    if (midToken) {
      midToken = false;
      if (elems.length > 0) elems[elems.length - 1]++;
    }
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (inString) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (blockComment > 0) {
      if (c === "#" && src[i + 1] === "|") {
        blockComment++;
        i++;
      } else if (c === "|" && src[i + 1] === "#") {
        blockComment--;
        i++;
      }
      continue;
    }
    if (inComment) {
      if (c === "\n") inComment = false;
      continue;
    }
    if (c === '"') {
      completeToken();
      inString = true;
      continue;
    }
    if (c === ";") {
      completeToken();
      inComment = true;
      continue;
    }
    if (c === "#" && src[i + 1] === "|") {
      completeToken();
      blockComment = 1;
      i++;
      continue;
    }
    if (REF_OPEN.has(c)) {
      completeToken();
      depth++;
      elems.push(0);
      continue;
    }
    if (REF_CLOSE.has(c)) {
      completeToken();
      depth--;
      if (depth < min) min = depth;
      elems.pop();
      if (elems.length > 0) elems[elems.length - 1]++;
      continue;
    }
    if (/\s/.test(c)) {
      completeToken();
      continue;
    }
    midToken = true;
  }
  const inText = inString || inComment || blockComment > 0;
  const frameElems = elems.length > 0 ? elems[elems.length - 1]! : -1;
  let position: RefState["position"];
  if (depth === 0) position = "top";
  else position = frameElems === 0 ? "operator" : "argument";
  return {
    depth,
    inString,
    inComment: inComment || blockComment > 0,
    midToken,
    position,
    closeable: depth === 0 && !inText,
    closeSuffix: depth > 0 ? ")".repeat(depth) : "",
    overClosed: min < 0 };
}
// --- end canonical reference ---------------------------------------------------------------------

/** All prefixes of `s`, from empty through the whole string. */
function prefixesOf(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i <= s.length; i++) out.push(s.slice(0, i));
  return out;
}

/** The corpus entries (one partial/whole program per non-blank, non-`;` line). */
function loadCorpus(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  const text = readFileSync(join(here, "fixtures", "scout-corpus.scm"), "utf8");
  return text
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim().length > 0 && !l.trim().startsWith(";"));
}

const CORPUS = loadCorpus();

// INVARIANT: the scout corpus fixture is non-trivial (more than 20 entries).
describe("oracle Layer-S — corpus loaded", () => {
  it("has a non-trivial corpus", () => {
    expect(CORPUS.length).toBeGreaterThan(20);
  });
});

// INVARIANT: arrival's structural scanner agrees with the canonical S-only reference
// reader on depth/inString/inComment/midToken/position/closeable/closeSuffix/overClosed,
// for every prefix of every corpus entry.
describe("oracle Layer-S — agrees with the canonical reference on every prefix", () => {
  it.each(CORPUS)("agrees on all prefixes of %j", (entry) => {
    for (const prefix of prefixesOf(entry)) {
      const ref = refAnalyze(prefix);
      const got = scan(prefix);
      const ctx = JSON.stringify(prefix);
      expect(got.depth, `depth @ ${ctx}`).toBe(ref.depth);
      expect(got.inString, `inString @ ${ctx}`).toBe(ref.inString);
      expect(got.inComment, `inComment @ ${ctx}`).toBe(ref.inComment);
      expect(got.midToken, `midToken @ ${ctx}`).toBe(ref.midToken);
      expect(got.position, `position @ ${ctx}`).toBe(ref.position);
      expect(got.closeable, `closeable @ ${ctx}`).toBe(ref.closeable);
      expect(got.closeSuffix, `closeSuffix @ ${ctx}`).toBe(ref.closeSuffix);
      expect(got.overClosed, `overClosed @ ${ctx}`).toBe(ref.overClosed);
    }
  });
});

// INVARIANT: feasible() equals ¬overClosed per the reference reader, for every prefix
// of every corpus entry.
describe("oracle Layer-S — feasible() matches structural feasibility (no over-close)", () => {
  it.each(CORPUS)("feasible matches reference on all prefixes of %j", (entry) => {
    for (const prefix of prefixesOf(entry)) {
      const ref = refAnalyze(prefix);
      expect(structuralScanner.feasible(prefix), `feasible @ ${JSON.stringify(prefix)}`).toBe(!ref.overClosed);
    }
  });
});

describe("oracle Layer-S — analyze() exposes the full contract surface with graceful Σ/T", () => {
  // INVARIANT: with no env injected, every prefix's validSymbols()/expectedType() are
  // null and produces() reports true (graceful Σ/T degradation).
  it.each(CORPUS)("Σ/T degrade gracefully on every prefix of %j (validSymbols=null, expectedType=null, produces=true)", (entry) => {
    for (const prefix of prefixesOf(entry)) {
      const st = structuralScanner.analyze(prefix);
      expect(st.validSymbols()).toBeNull();
      expect(st.expectedType()).toBeNull();
      expect(st.produces("anything", "AnyType")).toBe(true);
      expect(st.validClasses()).toBeInstanceOf(Set);
    }
  });

  // INVARIANT: appending closeSuffix to a well-nested, non-truncated prefix always
  // closes it to depth 0. Only well-nested, non-text-truncated entries are repairable
  // by appending closeSuffix — the corpus is pre-filtered to that subset (a row-
  // conditional skip on the full CORPUS would otherwise report a vacuous pass for
  // every truncated/in-text entry; per the it.each protocol, filter the row set
  // instead of branching inside the row).
  const REPAIRABLE = CORPUS.filter((entry) => {
    const st = structuralScanner.analyze(entry);
    return !st.overClosed && !st.inString && !st.inComment;
  });
  it.each(REPAIRABLE)("closeSuffix actually closes %j (appending it reaches depth 0 / closeable)", (entry) => {
    const st = structuralScanner.analyze(entry);
    const repaired = entry + st.closeSuffix;
    expect(scan(repaired).depth, `depth after repair of ${JSON.stringify(entry)}`).toBe(0);
  });

  // INVARIANT: validClasses() includes "end" iff closeable, and includes "close" iff
  // depth > 0 (outside string/comment).
  it.each(CORPUS)("validClasses gates `end`/`close` correctly on every prefix of %j", (entry) => {
    for (const prefix of prefixesOf(entry)) {
      const st = structuralScanner.analyze(prefix);
      const classes = st.validClasses();
      expect(classes.has("end")).toBe(st.closeable);
      if (!st.inString && !st.inComment) {
        expect(classes.has("close")).toBe(st.depth > 0);
      }
    }
  });
});

// INVARIANT: a char-by-char driven session's live state equals
// structuralScanner.analyze(prefix) at every step, for every prefix of every corpus
// entry. INVARIANT: Layer S never eagerly evaluates — session.lastClosed stays null
// and session.failed stays false throughout.
describe("oracle Layer-S — resumable session agrees with from-scratch analyze (the §A1 property)", () => {
  it.each(CORPUS)("session === analyze on every prefix of %j", (entry) => {
    // Drive a single session char-by-char; at each step its state must equal analyze(prefix).
    const session = structuralScanner.session!();
    for (let i = 0; i < entry.length; i++) {
      session.advance(entry[i]!);
      const prefix = entry.slice(0, i + 1);
      const fromScratch = structuralScanner.analyze(prefix);
      const live = session.state;
      const ctx = JSON.stringify(prefix);
      expect(live.depth, `depth @ ${ctx}`).toBe(fromScratch.depth);
      expect(live.inString, `inString @ ${ctx}`).toBe(fromScratch.inString);
      expect(live.inComment, `inComment @ ${ctx}`).toBe(fromScratch.inComment);
      expect(live.midToken, `midToken @ ${ctx}`).toBe(fromScratch.midToken);
      expect(live.position, `position @ ${ctx}`).toBe(fromScratch.position);
      expect(live.formKind, `formKind @ ${ctx}`).toBe(fromScratch.formKind);
      expect(live.strict, `strict @ ${ctx}`).toBe(fromScratch.strict);
      expect(live.closeable, `closeable @ ${ctx}`).toBe(fromScratch.closeable);
      expect(live.closeSuffix, `closeSuffix @ ${ctx}`).toBe(fromScratch.closeSuffix);
      expect(live.overClosed, `overClosed @ ${ctx}`).toBe(fromScratch.overClosed);
      // Layer S is structural-only: no eager evaluation.
      expect(session.lastClosed).toBeNull();
      expect(session.failed).toBe(false);
    }
  });

  // INVARIANT: clone() branches share no mutable state — advancing a branch leaves the
  // base session's state untouched.
  it("clone() branches with no shared mutable state", () => {
    const base = structuralScanner.session!("(filter signable");
    const branch = base.clone();
    branch.advance(" flows)");
    // The branch closed its forms; the base is untouched and still open.
    expect(branch.state.closeable).toBe(true);
    expect(base.state.closeable).toBe(false);
    expect(base.state.depth).toBe(1);
  });
});

describe("oracle Layer-S — char-vs-token gap (the load-bearing subtlety)", () => {
  // INVARIANT: a mid-token prefix like "(net" is feasible, and remains feasible after
  // appending a plausible token completion. INVARIANT: a mid-token prefix is not
  // closeable, is classified midToken with position "operator", and validClasses()
  // excludes "end".
  it("feasible(acceptedPrefix + candidateTokenString) on a mid-symbol prefix like '(net'", () => {
    // "(net" is mid-token (an atom being typed). A constrained decoder asks: is the candidate token
    // string a possible continuation? Structurally, completing the symbol and the form is possible.
    expect(structuralScanner.feasible("(net")).toBe(true);
    // Appending the rest of a plausible token keeps it possible.
    expect(structuralScanner.feasible("(net" + "work")).toBe(true);
    // Completing the form is possible (and closeable).
    expect(structuralScanner.feasible("(network)")).toBe(true);
    expect(structuralScanner.analyze("(network)").closeable).toBe(true);
    // The mid-symbol prefix is NOT closeable (an open form, a half-typed atom).
    const mid = structuralScanner.analyze("(net");
    expect(mid.midToken).toBe(true);
    expect(mid.position).toBe("operator"); // the head of the form is being typed
    expect(mid.closeable).toBe(false);
    expect(mid.validClasses().has("end")).toBe(false);
  });

  // INVARIANT: an over-close (e.g. ")", "(a))") is the one structurally-infeasible
  // case; a balanced close ("(a)") is feasible.
  it("an over-close is infeasible (the one structurally-rejected case)", () => {
    expect(structuralScanner.feasible(")")).toBe(false);
    expect(structuralScanner.feasible("(a))")).toBe(false);
    expect(structuralScanner.feasible("(a)")).toBe(true);
  });
});

describe("oracle Layer-S — formKind / strict (arrival-only contract additions)", () => {
  // INVARIANT: top level is formKind "top" and strict true.
  it("top level is top + strict", () => {
    const st = structuralScanner.analyze("");
    expect(st.formKind).toBe("top");
    expect(st.strict).toBe(true);
  });

  // INVARIANT: a quoted form (both `'(...` and `(quote ...` shapes) is formKind
  // "quote" and strict false.
  it("a quoted form is quote + lazy (Σ/T off)", () => {
    const st = structuralScanner.analyze("'(a ");
    expect(st.formKind).toBe("quote");
    expect(st.strict).toBe(false);
  });

  // INVARIANT: (same as above — the `(quote ...)` shape) formKind "quote", strict false.
  it("a (quote …) form is quote + lazy", () => {
    const st = structuralScanner.analyze("(quote (a ");
    expect(st.formKind).toBe("quote");
    expect(st.strict).toBe(false);
  });

  // INVARIANT: an if-branch is formKind "lazy-arm" and non-strict
  it("an if branch is a lazy-arm", () => {
    const st = structuralScanner.analyze("(if cond ");
    expect(st.formKind).toBe("lazy-arm");
    expect(st.strict).toBe(false);
  });

  // INVARIANT: an ordinary application argument is strict
  it("an ordinary application argument is strict", () => {
    const st = structuralScanner.analyze("(+ 1 ");
    expect(st.formKind).toBe("application");
    expect(st.strict).toBe(true);
  });

  // INVARIANT: the operator slot of an application is position "operator" with formKind "application"
  it("the operator slot of an application is strict application", () => {
    const st = structuralScanner.analyze("(");
    expect(st.position).toBe("operator");
    expect(st.formKind).toBe("application");
  });
});

// =================================================================================================
// Layer Σ (O2) — bound-symbol masking.
//
// Σ refines the `atom` class into the SET OF BOUND IDENTIFIERS legal at the cursor: boundSymbols()
// (from the injected discovery env) ∪ scope-locals (the prefix's own let/lambda/define binders),
// position-filtered (operator ⇒ callables, argument ⇒ any). With no env, Σ degrades to null — the
// Layer-S contract — which the 109 cases above already prove holds (validSymbols()=null there).
// =================================================================================================

/** A tiny discovery env with a callable builtin (`car`), a callable operator (`+`), and a
 *  non-callable value (`flows`). Σ sources boundSymbols()/isCallable() from this via makeOracleEnv. */
function sigmaEnv(): AmbientRuntime {
  const fn = (x: unknown): unknown => x;
  return mintPlainFrame(
    "sigma-test",
    {
      car: fn as unknown as AmbientValue,
      "+": fn as unknown as AmbientValue,
      flows: 42 as unknown as AmbientValue },
    null,
  );
}

describe("oracle Layer-Σ — graceful degradation when no env is injected", () => {
  // INVARIANT: with no env injected, validSymbols() stays null on every shape, identical to the Layer-S scanner
  it.each(["", "(", "(car ", "(let ((x 1)) (+ x ", "'(a "])(
    "makeOracle() (no env) keeps Σ null on shape %j — identical to the Layer-S scanner",
    (prefix) => {
      const oracle = makeOracle();
      expect(oracle.analyze(prefix).validSymbols(), `Σ @ ${JSON.stringify(prefix)}`).toBeNull();
    },
  );
});

describe("oracle Layer-Σ — env-backed validSymbols (live when an env is given)", () => {
  // INVARIANT: at operator position, an env-bound callable is valid and a non-callable bound name is excluded
  it("an env-bound builtin (car) appears at OPERATOR position; a non-callable (flows) does not", () => {
    const oracle = makeOracle(sigmaEnv());
    const st = oracle.analyze("(");
    expect(st.position).toBe("operator");
    const valid = st.validSymbols();
    expect(valid).not.toBeNull();
    expect(valid!.has("car")).toBe(true); // callable ⇒ legal operator
    expect(valid!.has("+")).toBe(true);
    expect(valid!.has("flows")).toBe(false); // non-callable ⇒ illegal operator head
  });

  // INVARIANT: at argument position, any bound symbol (callable or not) is valid
  it("at ARGUMENT position any bound symbol is valid (callable or not)", () => {
    const oracle = makeOracle(sigmaEnv());
    const valid = oracle.analyze("(car ").validSymbols();
    expect(valid).not.toBeNull();
    expect(valid!.has("flows")).toBe(true); // a value is a fine argument
    expect(valid!.has("car")).toBe(true);
  });

  // INVARIANT: a never-bound name is never in the valid set at either position.
  it("a NEVER-bound name is never in the valid set (operator or argument)", () => {
    const oracle = makeOracle(sigmaEnv());
    expect(oracle.analyze("(").validSymbols()!.has("nonesuch")).toBe(false);
    expect(oracle.analyze("(car ").validSymbols()!.has("nonesuch")).toBe(false);
  });

  // INVARIANT: makeOracleEnv enumerates the full parent chain and resolves
  // nearest-binding callability for inherited and own-frame names.
  it("makeOracleEnv enumerates the parent chain and resolves nearest-binding callability", () => {
    const root = mintPlainFrame("root", { car: ((x: unknown) => x) as unknown as AmbientValue }, null);
    const child = mintFrame(root, "child", { y: 7 as unknown as AmbientValue });
    const oe = makeOracleEnv(child);
    expect(oe.boundSymbols().has("car")).toBe(true); // inherited from parent
    expect(oe.boundSymbols().has("y")).toBe(true); // own frame
    expect(oe.isCallable("car")).toBe(true);
    expect(oe.isCallable("y")).toBe(false);
  });
});

describe("oracle Layer-Σ — lexical scope: a let-bound name is in scope inside BODY, absent outside", () => {
  // INVARIANT: a let-bound name is in validSymbols() inside its body.
  it("in (let ((x …)) BODY), x ∈ validSymbols() inside BODY", () => {
    const oracle = makeOracle(sigmaEnv());
    const inBody = oracle.analyze("(let ((x 1)) (+ x ").validSymbols();
    expect(inBody).not.toBeNull();
    expect(inBody!.has("x")).toBe(true);
  });

  // INVARIANT: a let-bound name drops out of validSymbols() once its form has closed.
  it("x ∉ validSymbols() once the let form has CLOSED (outside its body)", () => {
    const oracle = makeOracle(sigmaEnv());
    const outside = oracle.analyze("(let ((x 1)) (+ x)) (+ ").validSymbols();
    expect(outside).not.toBeNull();
    expect(outside!.has("x")).toBe(false);
  });

  // INVARIANT: a lambda parameter is in scope inside the lambda body.
  it("a lambda parameter is in scope inside the lambda body", () => {
    const oracle = makeOracle(sigmaEnv());
    const st = oracle.analyze("(lambda (y) (+ y ").validSymbols();
    expect(st!.has("y")).toBe(true);
  });

  // INVARIANT: a curried define binds both the function name and its parameters
  // inside the body.
  it("a curried define binds the function name AND its parameters in the body", () => {
    const oracle = makeOracle(sigmaEnv());
    const st = oracle.analyze("(define (f a b) (+ a ").validSymbols();
    expect(st!.has("f")).toBe(true);
    expect(st!.has("a")).toBe(true);
    expect(st!.has("b")).toBe(true);
  });

  // INVARIANT: a top-level define is visible to subsequent sibling forms.
  it("a top-level (define name …) is visible to following sibling forms", () => {
    const oracle = makeOracle(sigmaEnv());
    const st = oracle.analyze("(define foo 1) (+ foo ").validSymbols();
    expect(st!.has("foo")).toBe(true);
  });

  // INVARIANT: inside a quote, Σ is disabled entirely (validSymbols() null) since
  // quoted data may name any symbol.
  it("inside a quote, Σ is disabled (quoted data may name any symbol)", () => {
    const oracle = makeOracle(sigmaEnv());
    expect(oracle.analyze("'(a ").validSymbols()).toBeNull();
    expect(oracle.analyze("(quote (a ").validSymbols()).toBeNull();
  });

  // INVARIANT: at top level, Σ is null — a free-standing datum head is unconstrained
  // by the bound set.
  it("at TOP level Σ is null (a free-standing datum head is unconstrained by the bound set)", () => {
    const oracle = makeOracle(sigmaEnv());
    expect(oracle.analyze("").validSymbols()).toBeNull();
    expect(oracle.analyze("(a) ").validSymbols()).toBeNull();
  });
});
