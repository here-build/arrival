// doors — the ENVELOPE error surface (errors-as-doors, .claude/skills/errors-as-doors):
// every boundary rejection around the manifold's single-tool envelope is a DOOR — a
// structured {code, tier, fact, reason, script} payload built AT the rejection point,
// rendered to prose at the output layer. Codes are internal routing/telemetry keys
// (Rule 3) — they are logged and gate per-session verbosity, but the rendered text a
// model reads never shows one raw. Four codes, all owned by the envelope (the MCP
// call-shape boundary in front of the scheme surface — everything past it is arrival's
// own error contract, manifold-tool.ts):
//   envelope/bare-tool-call — the caller invoked a BOUND tool name as a standalone MCP
//                             tool; the door renders the exact retry expr FROM THE
//                             CALLER'S OWN ARGS (tier "translatable": lossless, but v1
//                             teaches instead of auto-applying — follow-rate data earns
//                             the flip, Rule 1).
//   envelope/unknown-tool   — the name is bound nowhere; did-you-mean over the catalog
//                             (tier "suggest-menu": choices offered, never picked).
//   envelope/empty-expr     — a manifold call with a whitespace-only expr.
//   envelope/invalid-args   — a manifold call with a missing/non-string expr.
//
// Verbosity is by per-session FIRST OCCURRENCE (Rule 4): the first time a lesson SHAPE fires
// in a server process's lifetime the door is verbose (concept intro); afterwards a terse
// one-liner. The gate keys on `door.verbosityKey ?? door.code` — the code alone for a code a
// single shape owns, a finer per-shape key for the codes that several DISTINCT shapes share
// (unbound-in-expr's tiers, scope-confusion's cases, the bypass global-collision note), so a
// model's genuine first encounter with one shape's lesson always teaches fully even when a
// SIBLING shape under the same code already fired. The Set lives in DoorSession — the OUTPUT
// layer — never here in the generators: a door builder always emits the same structured payload.
//
// Telemetry (Rule 5, minimal): every rendered door logs one structured stderr line
// {"door": code, "seq": n, "tool": name}; after a bare-tool-call/unknown-tool door for
// tool X, the next successful manifold call whose expr contains X logs
// {"door-followed": code, "tool": X}. Benches parse stderr; no config.

import type { BoundTool, ToolNaming } from "./bound-tool.js";
import { synthesizeExampleCall } from "./example-call.js";
import type { ToolJsonSchema } from "./tool-schema.js";
import type { TypeHintTelemetry } from "./type-hints/types.js";

/** Internal telemetry/log keys — never surfaced raw in door prose (Rule 3). */
export type DoorCode =
  | "envelope/bare-tool-call"
  | "envelope/unknown-tool"
  | "envelope/empty-expr"
  | "envelope/invalid-args"
  | "envelope/unbound-in-expr"
  // THE SCOPE-CONFUSION DOOR (docs/working-proposals/manifold-scope-confusion-door.md, V-
  // specified 2026-07-04) — the LAST branch of the unbound-in-expr classifier, on the DISJOINT
  // class of names the MODEL ITSELF defined: a same-program cascade (an earlier statement
  // failed so a later top-level define never bound), a cross-scope reference (X was only ever
  // let/lambda-bound, never at top level), or the ≥2-local "don't force an implementation"
  // case. See doors.ts's `scopeConfusionDoor` section for the full design.
  | "envelope/scope-confusion"
  // THE IMPORT-FORM DOOR (forensic finding, 2026-07-06): a benchmark model trained on real R7RS
  // repeatedly prepended a module-system form — `(import (scheme base))`, or a bare
  // `(scheme base)` when only the outer form got stripped — to every program, assuming this REPL
  // has a module system. It doesn't: `import` was deliberately deleted from the language (the
  // standard library is pre-bound; `require` is the loader for SOURCE FILES only — see
  // reference-import-deleted-require-is-the-loader.md). SIBLING of unbound-in-expr/scope-confusion:
  // fires on the two unbound heads that malformed form produces (`import`, `scheme`), which are
  // neither a tool name nor a data literal nor a name the model itself defined/locally bound, so
  // it runs between unboundInExprDoor (tool-name/literal classes) and scopeConfusionDoor
  // (self-defined-name classes) — see doors.ts's `importDoor` for the full design.
  | "envelope/import-form"
  // The SIGNATURE-ECHO hint (manifold-tool.ts) — the only in-expr enrichment that is NOT a
  // did-you-mean: when a statement's error is a tool-MISUSE shape (wrong kwarg / dangling
  // keyword / wrong arg type or shape / upstream argument rejection) and exactly one bound tool
  // is implicated, the tool's one-line catalog signature is echoed below the preserved error —
  // "this is how this symbol works". Telemetry only (no Door payload); the render lives inline.
  | "envelope/signature-echo"
  // The FUTILITY DOORS (the "futility door", futility.ts) — the only doors on a SUCCESSFUL call:
  // a tool whose repeated invocations are not moving the model forward. Rendered as advisory
  // `Note:` blocks (renderNote), never `Error:` — the tool's result is valid and flows untouched;
  // the note only tells the model to stop digging.
  | "envelope/futile-retry"
  | "envelope/duplicate-call"
  // THE BYPASS AUTO-EXEC MARKER (bind.ts's env-side BypassResolution, server.ts's CallTool
  // boundary): a direct (bypass) tool call that resolved to exactly ONE qualified tool was
  // translated and EXECUTED instead of taught. Telemetry only (no Door payload; the call's
  // own result — success or failure — travels untouched, prefixed with one advisory line) —
  // mirrors envelope/signature-echo's "logging without a rejection" shape. Kept DISTINCT from
  // envelope/bare-tool-call so a consumer counting "bypass attempts" (that code, unchanged)
  // can also see how many of those attempts were auto-executed rather than merely taught.
  | "envelope/bypass-autoexec";

/** The Applicability tier as TYPED METADATA on the rejection (Rule 1) — not prose. */
export type DoorTier = "translatable" | "suggest-menu" | "explain-route";

/** One boundary rejection, built AT the rejection point. `fact` names what collided,
 *  `reason` why the envelope owns it, `script` the exact recovery action (verbose
 *  rendering = fact + Why + script; `terse` is the one-liner for repeat occurrences —
 *  also built here so the output layer only ever CHOOSES, never composes). */
export interface Door {
  code: DoorCode;
  /** Per-SHAPE verbosity gate key (the OUTPUT layer's `DoorSession` keys its first-occurrence
   *  Set on `verbosityKey ?? code`). Set ONLY on a code that a SINGLE generator does NOT own —
   *  i.e. a code several DISTINCT lesson shapes emit (different trigger, different text), where
   *  each shape must teach FULLY on its own first occurrence rather than inherit a sibling
   *  shape's already-spent verbose slot. Absent (⇒ falls back to `code`) for every code with
   *  exactly one shape, so those keep the plain per-code gate byte-for-byte. `code` stays the
   *  telemetry/routing key regardless (Rule 3) — this only ever refines the verbosity gradient. */
  verbosityKey?: string;
  tier: DoorTier;
  fact: string;
  reason: string;
  script: string;
  terse: string;
}

// ─── literal rendering — the retry expr is built from the caller's own JSON args ───
// Same literal conventions as render-observation ({:k v} dicts, [...] vectors, quoted
// strings, true/false/nil — all first-class reader grammar), so the rendered retry is
// parseable by construction: pasting it into the manifold's expr evaluates.

const escapeString = (s: string): string =>
  s
    .replaceAll("\\", "\\\\")
    .replaceAll('"', String.raw`\"`)
    .replaceAll("\n", String.raw`\n`)
    .replaceAll("\t", String.raw`\t`)
    .replaceAll("\r", String.raw`\r`);

const BARE_KEY = /^[a-z][\w-]*$/i;

function renderJsonLiteral(value: unknown): string {
  if (value === null || value === undefined) return "nil";
  if (typeof value === "string") return `"${escapeString(value)}"`;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (Array.isArray(value)) return `[${value.map((v) => renderJsonLiteral(v)).join(" ")}]`;
  if (typeof value === "object") {
    const pairs = Object.entries(value as Record<string, unknown>).map(([k, v]) => {
      const key = BARE_KEY.test(k) ? `:${k}` : `"${escapeString(k)}"`;
      return `${key} ${renderJsonLiteral(v)}`;
    });
    return `{${pairs.join(" ")}}`;
  }
  return `"${escapeString(String(value))}"`;
}

/** TOP-LEVEL argument keys that CANNOT be written as a `:keyword` atom — a space, punctuation, or
 *  leading digit that a JSON object key / JSON Schema property name allows but this dialect's
 *  keyword-atom syntax can't read as one token (`:weird key` reads as THREE tokens — `:weird`,
 *  the symbol `key`, then the value — never one kwarg). Only the TOP-LEVEL kwargs slot is affected:
 *  a non-bare key INSIDE a `{...}` dict-literal VALUE is a different grammar position that
 *  {@link renderJsonLiteral} already quotes correctly, so this never recurses. Empty ⇒ every key
 *  renders as a faithful `:key value` pair. Reuses {@link BARE_KEY} — the same predicate
 *  renderJsonLiteral's dict branch and example-call.ts's renderCall use. */
export function nonBareKwargKeys(args: Record<string, unknown> | undefined): string[] {
  return Object.keys(args ?? {}).filter((k) => !BARE_KEY.test(k));
}

/** The exact retry expr for a bare tool call: the attempted JSON args as interleaved `:key value`
 *  kwargs on the QUALIFIED symbol — parseable by construction — OR `undefined` when no faithful
 *  call exists because a TOP-LEVEL argument key isn't a valid scheme keyword
 *  ({@link nonBareKwargKeys}). There is NO escape hatch: unlike a dict-literal VALUE's key (which
 *  renderJsonLiteral quotes inside `{...}`), the kwargs-call grammar has no quoted-key form, AND
 *  arrival's kwargs runtime rejects a single dict argument as an alternative ("kwargs call has a
 *  dangling keyword with no value — expected interleaved `:key value` pairs" — verified against the
 *  interpreter), so such an argument is STRUCTURALLY inexpressible to a bound tool. Callers MUST
 *  handle `undefined` — the LIVE bypass path (server.ts's autoExecuteBypass) declines to
 *  auto-execute and falls back to teaching; the teaching doors here degrade their script — and the
 *  `string | undefined` return makes emitting broken syntax a compile error rather than a
 *  runtime misfire. */
export function renderRetryExpr(qualifiedName: string, args: Record<string, unknown> | undefined): string | undefined {
  const entries = Object.entries(args ?? {});
  if (entries.length === 0) return `(${qualifiedName})`;
  if (entries.some(([k]) => !BARE_KEY.test(k))) return undefined;
  const kwargs = entries.map(([k, v]) => `:${k} ${renderJsonLiteral(v)}`).join(" ");
  return `(${qualifiedName} ${kwargs})`;
}

// ─── did-you-mean — simple prefix/edit-distance over the catalog (top 3) ───

function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const row = [i, ...Array.from({ length: n }, () => 0)];
    for (let j = 1; j <= n; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[n]!;
}

// ─── normalizeSymbolName — the canonical-form primitive (naming conventions are a
// separate research thread per MEMORY; this is deliberately the ONE generalized
// normalizer so a future symbol-identity comparison reuses it rather than growing a
// second bespoke one) ───

/** Canonical form of an identifier: lowercase, with camelCase word-boundaries AND the
 *  three separators arrival-manifold's naming space actually uses — `-` (kebab-case),
 *  `_` (snake_case — also today's qualified-name join character), `/` (the legacy
 *  namespace separator a model might still reach for out of habit) — all collapsed to
 *  the SAME token, so `searchNodes`, `search-nodes`, and `search_nodes` compare equal. A
 *  qualified `server_tool` name normalizes as ONE token too (`memory_search_nodes` →
 *  `memorysearchnodes`) — callers that want the bare tool part alone (ignoring a real
 *  server prefix) must read it off bind.ts's `tools` map (never re-split the
 *  qualified string — see bind.ts's module header) before calling this.
 *
 *  Exported and deliberately generic — not `unboundInExprDoor`-private — so a future
 *  naming-convention research thread (or any other symbol-identity comparison across
 *  camelCase/kebab-case/snake_case/namespaced spellings) has one canonical-form rule to
 *  reuse instead of reinventing it. */
// Pre-existing normalizer regex, a pure relocation from arrival-manifold/src/doors.ts. Inputs are
// bounded internal symbol/tool names (never adversarial user text), so the super-linear
// backtracking risk sonarjs/slow-regex warns about is not exploitable here — changing the pattern
// to appease the rule risks a behavioral drift in a load-bearing did-you-mean/tier-1 matcher
// rather than a pure copy.
// eslint-disable-next-line sonarjs/slow-regex
const CAMEL_ACRONYM_BOUNDARY = /([A-Z]+)([A-Z][a-z])/g;

export function normalizeSymbolName(s: string): string {
  return s
    .replaceAll(/[-_/]+/g, " ")
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replaceAll(CAMEL_ACRONYM_BOUNDARY, "$1 $2")
    .toLowerCase()
    .replaceAll(/\s+/g, "");
}

/** Nearest bound names for an unknown tool: scored against each qualified name AND its
 *  bare tool-name part (so `search_files` finds `filesystem_search_files`, and a
 *  hyphen/case-mangled `filesystem-search-files` lands one edit away), prefix matches
 *  score ahead of pure distance, top 3. The bare part is read off `tools` — bind.ts's
 *  structural (slug, tool) record — never re-derived by splitting `qualified` (that split
 *  is ambiguous once `_` is both the join character and a common word separator; see
 *  bind.ts's module header). A `qualified` absent from `tools` (defensive — every real
 *  bound name has an entry) falls back to comparing the full string only. */
export function nearestBoundNames(
  attempted: string,
  qualifiedNames: readonly string[],
  tools: ReadonlyMap<string, BoundTool>,
  top = 3,
): string[] {
  const needle = attempted.toLowerCase();
  return qualifiedNames
    .map((qualified) => {
      const bare = tools.get(qualified)?.tool ?? qualified;
      const candidates = [qualified.toLowerCase(), bare.toLowerCase()];
      const distance = Math.min(...candidates.map((c) => editDistance(needle, c)));
      const prefix = candidates.some((c) => c.startsWith(needle) || needle.startsWith(c));
      return { qualified, score: prefix ? Math.min(distance, 1) : distance };
    })
    .toSorted((a, b) => a.score - b.score)
    .slice(0, top)
    .map((entry) => entry.qualified);
}

// ─── door generators — pure payload builders, no session state (Rule 4) ───

/** The caller invoked a BOUND tool's name as a standalone MCP tool. `qualifiedNames` are
 *  every binding that name resolves to (one, normally; several only when the same bare
 *  name exists on multiple slugged servers). The recovery script is the exact retry expr
 *  rendered from the caller's own args. */
export function bareToolCallDoor(
  attempted: string,
  args: Record<string, unknown> | undefined,
  qualifiedNames: readonly string[],
  toolNaming: ToolNaming,
): Door {
  const [first, ...rest] = qualifiedNames;
  const qualified = first ?? attempted;
  const retry = renderRetryExpr(qualified, args);
  const alternates =
    rest.length > 0
      ? ` The same tool name is also bound as ${rest.join(", ")} — pick the server you mean the same way.`
      : "";
  // `retry === undefined` ⇒ a supplied argument KEY isn't a valid scheme keyword (a space /
  // punctuation / leading digit), so no faithful `:key value` call exists AND arrival's kwargs
  // runtime rejects a single dict argument too (see renderRetryExpr) — the argument is
  // structurally inexpressible. Teach the call SHAPE with keyword-safe names and NAME the offending
  // key(s), rather than interpolate a broken (or `undefined`) expr the model would copy verbatim.
  if (retry === undefined) {
    const bad = nonBareKwargKeys(args)
      .map((k) => `"${k}"`)
      .join(", ");
    return {
      code: "envelope/bare-tool-call",
      tier: "translatable",
      fact: `${attempted} is a symbol inside the ${toolNaming.toolName} tool's ${toolNaming.argName}, not a standalone tool.`,
      reason:
        `This server exposes ONE tool (${toolNaming.toolName}) so calls compose — a tool result can feed the ` +
        `next call inside the same program. Your argument key(s) ${bad} can't be written as a scheme ` +
        `keyword (:key), so this call can't be auto-translated.`,
      script:
        `Retry — call the ${toolNaming.toolName} tool with ${toolNaming.argName} = (${qualified} :key value …), using ` +
        `keyword-safe argument names.${alternates}`,
      terse: `bare tool call again — key(s) ${bad} aren't valid scheme keywords; call ${toolNaming.toolName} with (${qualified} :key value …).`,
    };
  }
  return {
    code: "envelope/bare-tool-call",
    tier: "translatable",
    fact: `${attempted} is a symbol inside the ${toolNaming.toolName} tool's ${toolNaming.argName}, not a standalone tool.`,
    reason:
      `This server exposes ONE tool (${toolNaming.toolName}) so calls compose — a tool result can feed ` +
      `the next call inside the same program.`,
    script: `Retry — call the ${toolNaming.toolName} tool with:\n  ${toolNaming.argName} = ${retry}${alternates}`,
    terse: `bare tool call again — wrap it: ${retry}`,
  };
}

/** THE AMBIGUOUS-BYPASS DOOR (bind.ts's env-side `BypassResolution`, "ambiguous" verdict):
 *  a direct (bypass) tool call whose bare name does NOT resolve to exactly one qualified
 *  tool — either because it ties across multiple bound tools (`candidates.length > 1`, the
 *  same bare/wire-form spelling shared by several servers) or because its canonical spelling
 *  ALSO names an existing GLOBAL scheme symbol unrelated to any tool (`candidates.length ===
 *  1`, `globalCollision` set — a builtin, an `s/*` validator, or any other bound name). Per
 *  V's tolerance rule (2026-07-05): never guess across variance, always ask. Reuses
 *  {@link bareToolCallDoor}'s retry-expr rendering (it already lists "alternates" for a
 *  multi-candidate tie); the global-collision case appends one sentence naming the colliding
 *  symbol so the model understands why an exact-looking match still wasn't auto-applied. */
export function ambiguousBypassDoor(
  attempted: string,
  args: Record<string, unknown> | undefined,
  candidates: readonly string[],
  toolNaming: ToolNaming,
  globalCollision?: string,
): Door {
  const base = bareToolCallDoor(attempted, args, candidates, toolNaming);
  if (globalCollision === undefined) return base;
  const note =
    ` "${globalCollision}" is ALSO a bound top-level symbol in this environment, unrelated to any tool — ` +
    `auto-translation is skipped on any possible collision; use the explicit call above if you meant the tool.`;
  return {
    ...base,
    verbosityKey: "envelope/bare-tool-call#global-collision",
    reason: `${base.reason}${note}`,
    terse: `${base.terse}${note}`,
  };
}

/** The attempted name is bound nowhere — did-you-mean over the catalog. */
export function unknownToolDoor(
  attempted: string,
  qualifiedNames: readonly string[],
  tools: ReadonlyMap<string, BoundTool>,
  toolNaming: ToolNaming,
): Door {
  const nearest = nearestBoundNames(attempted, qualifiedNames, tools);
  const menu = nearest.length > 0 ? `Did you mean: ${nearest.join(", ")}?\n  ` : "";
  const retryHead = nearest[0] ?? "server_tool-name";
  return {
    code: "envelope/unknown-tool",
    tier: "suggest-menu",
    fact: `${attempted} is not a tool on this server, and no bound symbol has that name.`,
    reason:
      `This server exposes ONE tool (${toolNaming.toolName}); every operation is a symbol you call ` +
      `INSIDE its ${toolNaming.argName}, and the tool's description lists every bound symbol.`,
    script: `${menu}Retry — call the ${toolNaming.toolName} tool with ${toolNaming.argName} = (${retryHead} :key value ...).`,
    terse:
      nearest.length > 0
        ? `unknown tool ${attempted} again — nearest bound symbols: ${nearest.join(", ")}; call them inside the ${toolNaming.toolName} tool's ${toolNaming.argName}.`
        : `unknown tool ${attempted} again — the ${toolNaming.toolName} tool is the only tool here; put operations inside its ${toolNaming.argName}.`,
  };
}

// ─── envelope/unbound-in-expr — THREE-TIER tool-resolution hint for an in-expr symbol wall ───
// The dominant self-inflicted failure inside a scheme expr is "Unbound variable `X'". X is
// almost always a bound TOOL called with the wrong shape (missing/garbled server prefix, wrong
// separator, a naming-convention mismatch), or a data literal that needed quoting (unchanged,
// orthogonal — see classifyLiteral/quotingHint below). A near-typo of a bound LIBRARY symbol
// (SRFI/R7RS builtin) is arrival's OWN job now — the `polyglot-rich-errors` capability enriches
// "Unbound variable" at the interpreter level against its curated well-known-symbol table, riding
// inside the SAME frozen first line this door's caller preserves (manifold-tool.ts never touches
// or duplicates arrival's message). This door only ever ENRICHES that wall with the indented
// suffix below it (never replaces — the frozen `Error: Unbound variable `X'` first line is
// preserved by the caller, manifold-tool.ts, which appends only the indented suffix this door
// carries).
//
// ─── THE CENTRAL DESIGN PRINCIPLE: never phrase a guess as a fact, never phrase a fact as a
// guess ─── An EXPLICIT hint (`the symbol you want is \`X\`.`) is a CLAIM we are certain of — an
// exact canonical-form match, or a bare-name edit distance of 1 (a single-character typo). A
// FUZZY LIST (`nearest tools: a, b, c.`) is a set of GUESSES — offered only when no single
// candidate clears the certainty bar. The model should never have to pick from a menu when we
// already know the exact token; it should never be TOLD a fact when we are only guessing.
//
// Only the ENUMERABLE tool bindings the caller holds participate here — manifold-tool.ts threads
// `signatureByName`'s keys (the exact qualified `server_tool` inventory bound into the env, one
// entry per tool, never a library builtin or an `s/*` validator — bind.ts populates it ONLY
// inside the per-tool loop). There is no library-name fallback set here by design — a typo of a
// well-known lisp-dialect symbol is arrival's curated concern, not "any bound non-tool name" (a
// far broader, uncurated set the manifold has no business guessing over).
//
// Steps run IN ORDER, first hit wins:
//   1. NORMALIZED BARE-NAME MATCH — `attempted` (or its bare part, after stripping a LEGACY `/`
//      prefix — see {@link bareNameOf}) canonicalizes (normalizeSymbolName) to the SAME form as
//      some bound tool's bare name (read off `tools`, bind.ts's structural (slug, tool)
//      record — never re-split from the qualified string): `searchNodes` / `search-nodes` both
//      → `search_nodes`. An EXACT canonical-form equality, not a fuzzy score — a naming-
//      CONVENTION difference, not a typo. Exactly ONE match is certain → the EXPLICIT fact door;
//      several (the same bare name bound on multiple servers) is a genuine tie, not a certainty
//      → the did-you-mean list stands.
//   2. RIGHT SERVER, WRONG TOOL — `attempted` carries a recognizable `server<sep>tool` shape
//      whose head names a REAL bound server, using the correct `_` (just a garbled tool part) or
//      a WRONG separator (`.`, `:`, `/` — the legacy shape, still a plausible habit). If the tool
//      part THEN canonical-matches exactly one real tool on that server, it's really a step-1 hit
//      reached via the split (explicit fact); several matching ties the same way step 1 does;
//      otherwise every tool bound on that server is listed, so the model sees the whole menu
//      instead of guessing again blind.
//   3. FUZZY FALLBACK (tool names only) — nothing normalizes or splits cleanly: the existing
//      edit-distance/prefix `nearestBoundNames`, widened to ~10 candidates, still gated by
//      `isCloseName` so genuinely-far junk yields nothing rather than a wrong suggestion. Within
//      that gated set, a candidate clearing the TIGHT bar (exact, or edit distance ≤ 1) and being
//      the ONLY such candidate is still a certainty — promoted to the explicit fact door; a
//      genuinely ambiguous or loose-only (prefix/distance-2) set renders as the guess list.

/** Strip a LEGACY `/`-qualified prefix from `s`, if present (`filesystem/search_files` →
 *  `search_files`) — a "/" is a namespace separator ONLY with a non-empty part on BOTH sides; a
 *  name that literally ends in "/" or IS "/" is not namespaced, so the whole name is its own bare
 *  name (otherwise the empty tail would prefix-match everything).
 *
 *  Unlike today's real join character (`_` — see bind.ts's module header), a literal `/` is
 *  NEVER part of ANY naming convention this dialect's identifiers use (camelCase / kebab-case /
 *  snake_case never contain one), so stripping whatever precedes the LAST `/` remains an
 *  unambiguous signal REGARDLESS of whether that prefix text names a real bound server — a
 *  wrong-but-well-formed guess still isolates the intended tool-name tail. This is deliberately
 *  narrower than {@link detectServerToolSplit} (which validates a split point against the KNOWN
 *  slug roster before trusting it): this helper never validates, it only recognizes the one
 *  character that stays unambiguous by construction.
 *
 *  This is an ATTEMPTED-string (arbitrary, possibly garbled) heuristic ONLY. A REAL qualified
 *  name's (slug, tool) parts are ALWAYS known exactly via bind.ts's `tools` map — never
 *  re-derive them by calling this on a name you already have bound. */
export const bareNameOf = (qualified: string): string => {
  const i = qualified.lastIndexOf("/");
  return i <= 0 || i === qualified.length - 1 ? qualified : qualified.slice(i + 1);
};

/** Group qualified tool names by SERVER SLUG, read off `tools` (bind.ts's structural
 *  (slug, tool) record for each bound name — never re-split from the qualified string; splitting
 *  is ambiguous once `_` both joins slug+tool AND commonly appears inside either half, see
 *  bind.ts's module header). A name with an empty slug (a single-server, slug-less binding) has
 *  no server concept and never contributes here or to {@link detectServerToolSplit} — it can
 *  only ever be a tier-1/tier-3 hit. A name absent from `tools` (defensive) is skipped the
 *  same way. */
function groupToolsByServer(
  qualifiedToolNames: readonly string[],
  tools: ReadonlyMap<string, BoundTool>,
): Map<string, string[]> {
  const groups = new Map<string, string[]>();
  for (const qualified of qualifiedToolNames) {
    const slug = tools.get(qualified)?.slug;
    if (!slug) continue;
    const bucket = groups.get(slug);
    if (bucket) bucket.push(qualified);
    else groups.set(slug, [qualified]);
  }
  return groups;
}

/** Wrong-shape separators a model might reach for in place of the manifold's `_` — kebab-case's
 *  `-` is deliberately EXCLUDED (a legitimate word separator inside a bare tool name, not a
 *  namespace mistake, and folded into tier 1 via {@link normalizeSymbolName} instead). `/` is
 *  included here now (rather than tried first, unconditionally) — it's the LEGACY separator, a
 *  plausible old-convention habit, but no longer the presumed-correct shape. */
const WRONG_SEPARATORS = [".", ":", "/"] as const;

/** Find a `server<sep>tool` split of `attempted` whose HEAD names a real bound server — trying
 *  `_` first (today's correct shape, across EVERY occurrence, leftmost first), then each wrong
 *  separator in turn, leftmost occurrence first. Returns the real slug (its bound casing) and
 *  the raw tool-part guess, or `undefined` when no split's head is a real server — the common
 *  case: no server prefix was attempted at all, or `attempted` is unrelated to any bound server.
 *
 *  Deliberately does NOT early-return on mere PRESENCE of `_` the way the old `/`-based version
 *  did (`if (attempted.includes("/")) return trySeparator("/")` — trusting the model's OWN
 *  stated separator completely once a `/` appeared ANYWHERE, never second-guessing with another
 *  separator). That shortcut was safe for `/` because it was rare/exclusive: its presence WAS a
 *  reliable signal of intent. It is UNSAFE for `_`: a slug or bare tool name may itself contain
 *  one (`search_nodes`), so `_`'s mere presence in a string using a DIFFERENT separator as its
 *  actual namespace divider (`memory.search_nodes` — `.` is the real split point, `_` is just
 *  internal to the tool name) does not mean `_` is THAT string's separator. So `_` is tried
 *  first across every occurrence (giving it priority as the presumed hypothesis), but a FAILED
 *  `_` attempt falls through to the wrong-separator list rather than giving up — the correct
 *  generalization once the presumed-correct character is no longer exclusive. */
function detectServerToolSplit(
  attempted: string,
  serverGroups: ReadonlyMap<string, readonly string[]>,
): { server: string; toolGuess: string } | undefined {
  const bySlugLower = new Map([...serverGroups.keys()].map((slug) => [slug.toLowerCase(), slug] as const));
  const trySeparator = (sep: string): { server: string; toolGuess: string } | undefined => {
    let from = 0;
    for (;;) {
      const i = attempted.indexOf(sep, from);
      if (i <= 0 || i === attempted.length - 1) return undefined;
      const server = bySlugLower.get(attempted.slice(0, i).toLowerCase());
      if (server !== undefined) return { server, toolGuess: attempted.slice(i + 1) };
      from = i + 1;
    }
  };
  const viaCorrectSeparator = trySeparator("_");
  if (viaCorrectSeparator) return viaCorrectSeparator;
  for (const sep of WRONG_SEPARATORS) {
    const found = trySeparator(sep);
    if (found) return found;
  }
  return undefined;
}

/** TIER 1: every bound tool whose bare name (read off `tools`, never re-split from the
 *  qualified string) canonicalizes equal to `attempted`'s bare part. A LEGACY `/` prefix on
 *  `attempted`, if any, is stripped first via {@link bareNameOf} — still an unambiguous signal in
 *  arbitrary text (see its doc) — everything else about the string, including a garbled prefix,
 *  folds into the canonical form. `attempted` is deliberately NOT stripped on `_`: unlike `/`, an
 *  underscore in `attempted` might be the real separator, might be internal to the intended bare
 *  name, or might be both at once (`toy_whois_json`) — {@link detectServerToolSplit} (tier 2)
 *  resolves that ambiguity by validating against the KNOWN slug roster; this tier only handles
 *  the unconditionally-safe case. */
function tier1Matches(
  attempted: string,
  qualifiedToolNames: readonly string[],
  tools: ReadonlyMap<string, BoundTool>,
): string[] {
  const target = normalizeSymbolName(bareNameOf(attempted));
  return qualifiedToolNames.filter((tool) => normalizeSymbolName(tools.get(tool)?.tool ?? tool) === target);
}

/** The CLOSENESS gate applied at tier 3 (the fuzzy fallback): a candidate is a "nearest tool"
 *  only on an EXACT bare/full-name match, a ≥3-char prefix relation either direction, or a
 *  bare-name edit distance ≤ 1 (a single typo) — widened to ≤ 2 only for a LONG (≥8-char)
 *  attempt. The length gate is the precision knob against short-name false positives
 *  (`never`↔`every`), while realistic de-namespaced tool names are long (`search_files`,
 *  `directory_tree`) and their distance-2 garbles are safe to suggest. `nearestBoundNames`
 *  returns its top-N regardless of distance, so this filter is what keeps a genuinely-unknown
 *  symbol from drawing a wrong suggestion — it reuses the module's editDistance, it is not a
 *  second fuzzy matcher. `candidate`'s bare part is read off `tools` (never re-split — see
 *  bind.ts's module header).
 *
 *  Exported ONLY so a drift-guard test (calibration-constants.test.ts) can pin the embedded
 *  distance-gate constants (`1`, `2`, `8`) by DRIVING this function directly at the exact
 *  boundary, rather than re-deriving the same gate in test code — see competence.ts's
 *  `WINDOW_SIZE` doc comment for why these are being made observable ahead of the migration. */
/** A ≥3-char prefix relation either direction — hoisted out of {@link isCloseName} (no closure
 *  capture; pure over its own two args) so it is defined once per module instead of once per
 *  call. */
const prefixPair = (x: string, y: string): boolean => x.length >= 3 && y.startsWith(x);

export function isCloseName(attempted: string, candidate: string, tools: ReadonlyMap<string, BoundTool>): boolean {
  const a = attempted.toLowerCase();
  const full = candidate.toLowerCase();
  const bare = (tools.get(candidate)?.tool ?? candidate).toLowerCase();
  if (a === bare || a === full) return true;
  if (prefixPair(a, bare) || prefixPair(bare, a) || prefixPair(a, full) || prefixPair(full, a)) return true;
  const distance = editDistance(a, bare);
  return distance <= 1 || (distance <= 2 && a.length >= 8);
}

/** The EXPLICIT-hint confidence bar (module header's central design principle): exact match, or
 *  a bare/full-name edit distance of 1 — a single-character typo, transposition, or one-off
 *  insertion/deletion. Deliberately NARROWER than {@link isCloseName}'s list-gate (no prefix
 *  relation, no widened distance-2-for-long-strings): a prefix or distance-2 relation is a
 *  plausible GUESS, not a certainty. Shared by the tier-3 promotion (a single tight candidate in
 *  the closeness-gated set becomes the explicit door) and the library-typo hint (step 4).
 *  `candidate`'s bare part is read off `tools` (never re-split). */
function isTightMatch(attempted: string, candidate: string, tools: ReadonlyMap<string, BoundTool>): boolean {
  const a = attempted.toLowerCase();
  const bare = (tools.get(candidate)?.tool ?? candidate).toLowerCase();
  const full = candidate.toLowerCase();
  if (a === bare || a === full) return true;
  return editDistance(a, bare) <= 1 || editDistance(a, full) <= 1;
}

/** Data-literal shape classifier: `"null"` (its own nil/omit teaching), `"general"` (a value
 *  that should have been quoted), or `undefined` (no literal shape — leave the wall untouched
 *  rather than teach something false, the task's rule 4). */
function classifyLiteral(x: string): "null" | "general" | undefined {
  if (/^null$/i.test(x)) return "null";
  if (/^(?:true|false)$/i.test(x)) return "general"; // JSON booleans
  if (/^\d{4}-\d{2}-\d{2}/.test(x)) return "general"; // ISO date
  if (/^[+-]?\d[\d.,:]*[a-z%]*$/i.test(x)) return "general"; // a number with stray chars
  if (/^[A-Z][A-Z0-9_]+$/.test(x)) return "general"; // ALL-CAPS enum/const token
  if (/\w\.\w/.test(x)) return "general"; // dotted — domain / filename
  if (/^\*.+\*$/.test(x)) return "general"; // *starred* placeholder
  return undefined;
}

/** The quoting hint for a data-literal-shaped symbol. `null` gets the arrival-specific nil/omit
 *  teaching; everything else is told to quote (or keyword it, where a parameter name is meant). */
function quotingHint(x: string, kind: "null" | "general"): string {
  if (kind === "null") {
    return "JSON null is spelled '() (empty/nil) here; in tool arguments simply OMIT the optional parameter instead of passing null.";
  }
  return `${x} looks like a data value, not a symbol — write it as the string "${x}" (or keyword :${x} where a parameter name is meant).`;
}

/** True iff `qualifiedName` was bound under a non-empty server slug — read off `tools`
 *  (bind.ts's structural (slug, tool) record), NEVER by inspecting the qualified string itself
 *  (a `.includes("_")`-style check would be worthless: most bare tool names contain an
 *  underscore of their own, slug or not — see bind.ts's module header). A name absent from
 *  `tools` (defensive — every real bound name has an entry) is treated as NOT namespaced —
 *  the safe default (never phrase a guess as a fact, the module's central design principle). */
function isNamespaced(qualifiedName: string, tools: ReadonlyMap<string, BoundTool>): boolean {
  return (tools.get(qualifiedName)?.slug ?? "") !== "";
}

/** THE EXAMPLE-CALL TEACHING (V's design, 2026-07-05): a resolved tool doesn't just get NAMED
 *  any more — it gets a FULL WORKING CALL EXAMPLE, synthesized straight off its declared JSON
 *  Schema (example-call.ts), so the model can copy it verbatim and fill in real values instead
 *  of re-deriving the call shape from a bare symbol. A name absent from `toolSchemas` (no schema
 *  known — the default empty map every caller not threading one gets) degrades gracefully to a
 *  bare `(qualifiedName)` example, never a crash. */
function renderExampleCall(
  qualifiedName: string,
  toolSchemas: ReadonlyMap<string, ToolJsonSchema | undefined>,
): string {
  return synthesizeExampleCall(qualifiedName, toolSchemas.get(qualifiedName));
}

/** Several candidates' example calls, in the SAME order as the names they're offered alongside —
 *  used by the tie/fuzzy doors below, where the model must pick ONE of several plausible tools. */
function renderExampleCalls(
  qualifiedNames: readonly string[],
  toolSchemas: ReadonlyMap<string, ToolJsonSchema | undefined>,
): string {
  return qualifiedNames.map((name) => renderExampleCall(name, toolSchemas)).join("; ");
}

/** THE EXPLICIT TOOL DOOR — a single tool resolves with CERTAINTY (an exact canonical-form
 *  match from step 1/2, or the single tight edit-distance-≤1 candidate promoted at step 3):
 *  state the exact qualified token as FACT, not a question, so the model can copy it verbatim
 *  instead of picking from a menu — the central design principle (module header). The prefix
 *  teaching is only truthful when the token is actually namespaced ({@link isNamespaced}); a
 *  slug-less bare binding gets the plain fact with no prefix note. `literal` rides along as the
 *  second line on the combined case (unchanged, orthogonal concern). A full working call example
 *  (the example-call teaching above) rides on BOTH `fact` (verbose) and `terse` (repeat
 *  occurrences already fold their OWN actionable payload into `terse` elsewhere in this module —
 *  see `bareToolCallDoor`'s retry expr — so this door matches that convention). */
function explicitToolDoor(
  qualifiedName: string,
  literal: "null" | "general" | undefined,
  attempted: string,
  tools: ReadonlyMap<string, BoundTool>,
  toolSchemas: ReadonlyMap<string, ToolJsonSchema | undefined>,
  toolNaming: ToolNaming,
): Door {
  const teach = isNamespaced(qualifiedName, tools)
    ? ` Tool symbols keep their full server_tool-name form inside ${toolNaming.argName}.`
    : "";
  const example = renderExampleCall(qualifiedName, toolSchemas);
  return {
    code: "envelope/unbound-in-expr",
    verbosityKey: "envelope/unbound-in-expr#explicit",
    tier: "explain-route",
    fact: `There's no such symbol — the symbol you want is \`${qualifiedName}\`.${teach} For example: ${example}`,
    reason: literal === undefined ? "" : quotingHint(attempted, literal),
    script: "",
    terse: `the symbol you want is \`${qualifiedName}\` — e.g. ${example}.`,
  };
}

/** TIER 1's TIE door (also reached via a tier-2 split that resolves to SEVERAL real tools,
 *  doors.ts § "RIGHT SERVER, WRONG TOOL"): several matches is a genuine tie, not a certainty —
 *  the did-you-mean list stands (a single match is the {@link explicitToolDoor} fact instead).
 *  The prefix teaching is only truthful when the matches are actually namespaced
 *  ({@link isNamespaced}); a slug-less bare binding gets a plain did-you-mean. `literal` rides
 *  along as the second line on the combined case. Every candidate's example call renders too
 *  (the example-call teaching above), framed as a pick-one choice — never a bare name-only
 *  menu the model must re-derive a call shape from. */
function tier1Door(
  matches: readonly string[],
  literal: "null" | "general" | undefined,
  attempted: string,
  tools: ReadonlyMap<string, BoundTool>,
  toolSchemas: ReadonlyMap<string, ToolJsonSchema | undefined>,
  toolNaming: ToolNaming,
): Door {
  const namespaced = matches.some((m) => isNamespaced(m, tools));
  const teach = namespaced ? ` Tool symbols keep their full server_tool-name form inside ${toolNaming.argName}.` : "";
  const examples = renderExampleCalls(matches, toolSchemas);
  return {
    code: "envelope/unbound-in-expr",
    verbosityKey: "envelope/unbound-in-expr#tie",
    tier: "suggest-menu",
    fact: `There's no such symbol — did you mean: ${matches.join(", ")}?${teach} Pick the one you mean — for example: ${examples}`,
    reason: literal === undefined ? "" : quotingHint(attempted, literal),
    script: "",
    terse: `did you mean: ${matches.join(", ")}? e.g. ${examples}`,
  };
}

/** TIER 2's door: the server part was real but no tool on it matched — list every tool bound on
 *  that server (bare names, read off `tools` — the form the model actually calls them by
 *  inside a namespaced symbol) so the model sees the whole menu instead of guessing blind a
 *  second time. Deliberately NOT upgraded with the example-call teaching (unlike
 *  {@link explicitToolDoor}/{@link tier1Door}/{@link tier3Door} below): this is a discovery
 *  menu over a whole server's toolset (zero of them matched the guess), not a set of candidates
 *  that DID match — rendering one example per listed tool here risks a response that scales
 *  with server size rather than with actual ambiguity. */
function tier2Door(
  server: string,
  toolGuess: string,
  toolsOnServer: readonly string[],
  literal: "null" | "general" | undefined,
  attempted: string,
  tools: ReadonlyMap<string, BoundTool>,
): Door {
  const bareTools = toolsOnServer.map((t) => tools.get(t)?.tool ?? t).join(", ");
  return {
    code: "envelope/unbound-in-expr",
    verbosityKey: "envelope/unbound-in-expr#server-menu",
    tier: "suggest-menu",
    fact: `server \`${server}\` has no tool \`${toolGuess}\` — its tools are: ${bareTools}.`,
    reason: literal === undefined ? "" : quotingHint(attempted, literal),
    script: "",
    terse: `server \`${server}\` has no tool \`${toolGuess}\` — its tools: ${bareTools}.`,
  };
}

/** TIER 3's fuzzy-fallback candidate count — widened from the old did-you-mean's 3 toward ~10
 *  (still `isCloseName`-gated, so the wider net doesn't admit distant junk).
 *
 *  Exported ONLY so a drift-guard test (calibration-constants.test.ts) can pin its literal value
 *  — see competence.ts's `WINDOW_SIZE` doc comment for why: this is a calibration constant the
 *  migration's Round 1 flags for eventually becoming an injected option; exporting it now makes
 *  today's value observable without changing any behavior. */
export const TIER3_TOP = 10;

/** TIER 3's door: nothing normalized or split cleanly — the closeness-gated fuzzy fallback,
 *  drawn only from tool names (never general library syntax, per the door's narrowed job).
 *  Every candidate's example call renders too (the example-call teaching above), same pick-one
 *  framing as {@link tier1Door}'s tie. */
function tier3Door(
  nearest: readonly string[],
  literal: "null" | "general" | undefined,
  attempted: string,
  toolSchemas: ReadonlyMap<string, ToolJsonSchema | undefined>,
): Door {
  const examples = renderExampleCalls(nearest, toolSchemas);
  return {
    code: "envelope/unbound-in-expr",
    verbosityKey: "envelope/unbound-in-expr#fuzzy",
    tier: "suggest-menu",
    fact: `There's no such symbol — nearest tools: ${nearest.join(", ")}. Pick the one you mean — for example: ${examples}`,
    reason: literal === undefined ? "" : quotingHint(attempted, literal),
    script: "",
    terse: `nearest tools: ${nearest.join(", ")}. e.g. ${examples}`,
  };
}

/** Build the enrichment door for an in-expr "Unbound variable `X'" — the three-tier tool
 *  resolution (see the section header above). Returns `undefined` when nothing matches and no
 *  data-literal shape is found either — the caller then leaves arrival's wall untouched (a plain
 *  typo'd variable teaching nothing false beats a wrong guess; a typo of a well-known LIBRARY
 *  symbol is arrival's own `polyglot-rich-errors` capability's job, already riding inside the
 *  frozen first line by the time this door runs). `qualifiedToolNames` is the manifold's tool
 *  inventory (manifold-tool.ts threads `signatureByName`'s keys). When the attempted symbol ALSO
 *  looks like a data literal, the quoting hint rides along as a second line regardless of which
 *  step (or none) fired.
 *
 *  This door renders INLINE (DoorSession.enrichInline): `fact` is the primary teaching line,
 *  `reason` the optional second line, `terse` the repeat-occurrence one-liner. `script` is unused
 *  (the door never routes through the standalone `Error: fact / Why / script` render). */
export function unboundInExprDoor(
  attempted: string,
  qualifiedToolNames: readonly string[],
  tools: ReadonlyMap<string, BoundTool>,
  toolNaming: ToolNaming,
  toolSchemas: ReadonlyMap<string, ToolJsonSchema | undefined> = new Map(),
  /** STEP 3's fuzzy-fallback candidate count — the calibration seam (calibration.ts's
   *  `doorsTier3Top`): a re-tune is an injected option, never a code fork. Defaults to
   *  {@link TIER3_TOP} — today's value, unchanged for every caller that doesn't pass one. */
  tier3Top: number = TIER3_TOP,
): Door | undefined {
  const literal = classifyLiteral(attempted);

  // STEP 1 — normalized bare-name match, no server prefix assumed. Exactly one match is
  // certain (an exact canonical-form equality) → the explicit fact; several is a genuine tie.
  const direct = tier1Matches(attempted, qualifiedToolNames, tools);
  if (direct.length === 1) return explicitToolDoor(direct[0]!, literal, attempted, tools, toolSchemas, toolNaming);
  if (direct.length > 1) return tier1Door(direct, literal, attempted, tools, toolSchemas, toolNaming);

  // STEP 2 — a recognizable `server<sep>tool` split whose head is a REAL bound server. A
  // SINGLE tool match on that server is really a step-1 hit reached via the split (explicit);
  // several ties the same way step 1 does; no match is the server's tool menu.
  const serverGroups = groupToolsByServer(qualifiedToolNames, tools);
  const split = detectServerToolSplit(attempted, serverGroups);
  if (split) {
    const toolsOnServer = serverGroups.get(split.server)!;
    const normalizedGuess = normalizeSymbolName(split.toolGuess);
    const matches = toolsOnServer.filter((t) => normalizeSymbolName(tools.get(t)?.tool ?? t) === normalizedGuess);
    if (matches.length === 1) return explicitToolDoor(matches[0]!, literal, attempted, tools, toolSchemas, toolNaming);
    if (matches.length > 1) return tier1Door(matches, literal, attempted, tools, toolSchemas, toolNaming);
    return tier2Door(split.server, split.toolGuess, toolsOnServer, literal, attempted, tools);
  }

  // STEP 3 — fuzzy fallback, drawn only from tool names, closeness-gated (short attempts are
  // never fuzzy-matched — too many false positives against even a handful of tool names). A
  // single TIGHT candidate inside that gated set is still a certainty (an edit-distance-1
  // typo) → promoted to the explicit fact; a genuinely ambiguous or loose-only set is the guess
  // list.
  if (attempted.length >= 2) {
    const nearest = nearestBoundNames(attempted, qualifiedToolNames, tools, tier3Top).filter((c) =>
      isCloseName(attempted, c, tools),
    );
    const tight = nearest.filter((c) => isTightMatch(attempted, c, tools));
    if (tight.length === 1) return explicitToolDoor(tight[0]!, literal, attempted, tools, toolSchemas, toolNaming);
    if (nearest.length > 0) return tier3Door(nearest, literal, attempted, toolSchemas);
  }

  // Nothing matched — the data-literal shape, if any, is the only remaining signal.
  if (literal === undefined) return undefined;
  const hint = quotingHint(attempted, literal);
  return {
    code: "envelope/unbound-in-expr",
    verbosityKey: "envelope/unbound-in-expr#quote-literal",
    tier: "explain-route",
    fact: hint,
    reason: "",
    script: "",
    terse: hint,
  };
}

// ─── envelope/import-form — the "this REPL has a module system" misfire ───
// Forensic finding (2026-07-06): a benchmark model prepended `(import (scheme base))` (malformed
// R7RS — real R7RS spells it `(import (scheme base))` too, but this REPL binds no `import` special
// form at all) to EVERY program in an 11-call run; the runner never redirected it, so the model
// hit "Unbound variable `import'" (or, once it tried stripping just the outer form, "Unbound
// variable `scheme'" from the bare `(scheme base)` left behind) again and again with no lesson
// attached. Neither head is a tool name or a data literal (unboundInExprDoor's two classes) or a
// name the model itself top-level-defined/locally-bound (scopeConfusionDoor's three classes), so
// both upstream doors legitimately return undefined and the bare wall would otherwise go untaught
// forever. This door is a narrow, exact-match SIBLING check consulted between them (runner.ts):
// after unboundInExprDoor (a tool literally named `import`/`scheme` is implausible, but a tool
// door still takes precedence by design) and before scopeConfusionDoor (an import/scheme unbound
// is never something the model defined or locally bound, so that classifier would fall through to
// undefined anyway — this door catches it first with the actually-relevant, targeted lesson).

/** The two unbound heads a malformed `(import (scheme base))` produces: the form's own head
 *  symbol, and — once a caller strips only the outer form — the bare `scheme` head left behind
 *  by `(scheme base)`. An EXACT match only (never fuzzy/prefix) — this is a single, precisely
 *  known misfire shape, not a general did-you-mean surface. */
const IMPORT_FORM_HEADS = new Set(["import", "scheme"]);

/** Build the import-form door, or `undefined` when `attempted` is neither unbound head this
 *  misfire produces. Returns a `Door` (never a bare string) so the caller renders it through
 *  `DoorSession.enrichInline` exactly like every other unbound-in-expr/scope-confusion
 *  enrichment — the SAME per-session verbosity gate (Rule 4) applies, so an 11-call run that
 *  repeats this same mistake teaches the full lesson ONCE, then collapses to `terse` — never 11
 *  verbose repeats. */
export function importDoor(attempted: string): Door | undefined {
  if (!IMPORT_FORM_HEADS.has(attempted)) return undefined;
  const fact =
    "There's no `(import ...)` or `(scheme ...)` module form here — `import` was deliberately " +
    "removed from this language and there's no module system to invoke. The standard library is " +
    "already fully bound into this REPL's scope, so nothing needs importing. Drop that form and " +
    "resend the rest of the program unchanged.";
  return {
    code: "envelope/import-form",
    tier: "explain-route",
    fact,
    reason: "",
    script: "",
    terse:
      "no `(import ...)`/`(scheme ...)` form here — the standard library is already in scope; " +
      "drop it and resend the rest of the program unchanged.",
  };
}

// ─── envelope/scope-confusion — same-program cascade / cross-scope / repeated-local-binding
// enrichment for a self-defined-then-unbound name ───
// docs/working-proposals/manifold-scope-confusion-door.md (V-specified 2026-07-04). SIBLING of
// unboundInExprDoor, on the DISJOINT class of names the MODEL ITSELF defined: a tool-name miss
// or a data-literal-shaped token is never this door's concern (unboundInExprDoor owns those and
// runs FIRST — this door only ever fires when it returned undefined, manifold-tool.ts). Three
// cases:
//   (a) SAME-PROGRAM CASCADE — X has a top-level `(define X ...)` earlier in THIS program, but
//       (necessarily, since X is now unbound) that define's own evaluation never bound X because
//       an earlier statement in the SAME program failed first (REPL-continue lets siblings run,
//       but a statement whose OWN evaluation depends on an unbound name from an earlier failure
//       fails too — a real dependency chain, not a metaphor). Point at the FIRST failing
//       statement, not the symptom — "delete a reasoning turn" (the module header's central
//       design principle, applied to a different axis: don't make the model re-derive what it
//       can be told directly).
//   (b) CROSS-SCOPE — X was only ever bound inside a local scope (a let/let*/letrec/letrec*
//       binding, a lambda parameter, or a nested define) — NEVER at top level, in this call or
//       an earlier one. A local binding's lifetime is its enclosing form; referencing it later
//       (a different statement, let alone a different call) is not a persistence bug — it never
//       had persistence to begin with.
//   (c) THE ≥2-LOCAL SPECIAL CASE (V's flag, spec header) — X was locally bound this way TWICE
//       or more across the session: the model has a consistent local-binding STYLE, not a
//       one-off mistake. Forcing it toward top-level `(define)` here would fight a working style
//       instead of the actual confusion — acknowledge both paths, prescribe neither.
// (d) is the absence of all three — a name never defined anywhere, top-level or local — and is
// NOT a Door this module builds at all: `scopeConfusionDoor` returns undefined and the caller
// (manifold-tool.ts) leaves the bare "Unbound variable" wall untouched.
//
// Detection facts are precomputed by the CALLER (Rule 4: door generators hold no session state
// and do no scanning themselves — same discipline as every other generator in this file):
//   • `topLevelDefineStatementNumber` — manifold-tool.ts scans THIS PROGRAM's own `statements`
//     (already split by splitTopLevel) for an earlier `(define X ...)`, via `topLevelDefineName`.
//     Undefined ⇒ X was never top-level-defined IN THIS PROGRAM (the only signal case (a) needs
//     — a define attempted in a PRIOR call and never in this one falls to (b)/(c)/(d) instead,
//     out of this door's same-program scope by design, per the spec's own title).
//   • `firstErrorStatementNumber` — always available once this function is even reached (the
//     CURRENT statement just errored, so the caller's `erroredStatementIndexes` is never empty)
//     — the 1-based index of the earliest failing statement in this program so far. Only USED
//     when `topLevelDefineStatementNumber` is set (the cascade case).
//   • `localBindingCallIndexes` — session-history.ts's `LocalBindingTracker.occurrences(name)`:
//     every call index (this session, oldest→newest) at which X appeared as a let/lambda/
//     nested-define bound name (scope-scan.ts's `scanLocalBindings` feeds the tracker). `[]` ⇒
//     never locally bound either ⇒ case (d).
//   • `currentCallIndex` — the SAME per-tool call counter the tracker's occurrences are indexed
//     by, so a single prior occurrence can report "N message(s) ago" (0 ⇒ "this message").

/** The facts `scopeConfusionDoor` classifies on — precomputed by the caller (manifold-tool.ts),
 *  never derived here (Rule 4: door generators hold no session state and do no scanning). */
export interface ScopeConfusionInput {
  /** The unbound name. */
  name: string;
  /** 1-based statement number of X's top-level `(define X ...)` EARLIER in THIS program, or
   *  undefined when no such define exists among this program's own statements. */
  topLevelDefineStatementNumber?: number;
  /** 1-based statement number of the FIRST statement that failed in this program so far —
   *  always defined by the time this is called (the current statement's own failure already
   *  counts). Only USED when `topLevelDefineStatementNumber` is set (the cascade case). */
  firstErrorStatementNumber: number;
  /** Every call index (this session, oldest→newest) at which `name` was recorded as a LOCAL
   *  (let/lambda/nested-define) binding — session-history.ts's `LocalBindingTracker`. */
  localBindingCallIndexes: readonly number[];
  /** The CURRENT call's index (the same counter `localBindingCallIndexes` are recorded under). */
  currentCallIndex: number;
}

/** Build the scope-confusion door's CASCADE case: X has a top-level define attempt earlier in
 *  this SAME program, but it never bound because an earlier statement failed first. Points at
 *  the ROOT (the first failing statement), never the symptom. */
function cascadeScopeDoor(name: string, firstErrorStatementNumber: number): Door {
  const fact =
    `\`${name}' was defined above in this program, but an earlier statement failed, so its ` +
    `(define) never ran — every statement after the first error is skipped. Fix the FIRST ` +
    `error (see the error at statement ${firstErrorStatementNumber}) and the rest will bind.`;
  return {
    code: "envelope/scope-confusion",
    verbosityKey: "envelope/scope-confusion#cascade",
    tier: "explain-route",
    fact,
    reason: "",
    script: "",
    terse: `\`${name}' never bound — statement ${firstErrorStatementNumber} failed first; fix that and the rest will bind.`,
  };
}

/** Build the scope-confusion door's CROSS-SCOPE case: X was only ever locally bound (a
 *  let/lambda body or a nested define), never at top level — a local binding's lifetime is its
 *  enclosing form, so it never persisted to begin with. */
function crossScopeDoor(name: string, messagesAgo: number): Door {
  const when =
    messagesAgo <= 0 ? "earlier in this message" : `${messagesAgo} message${messagesAgo === 1 ? "" : "s"} ago`;
  const fact =
    `\`${name}' was defined inside a local scope (a let/lambda body) ${when}, not globally — a ` +
    `local binding doesn't survive its form. Re-declare it at top level with (define ${name} …), ` +
    `or bind it locally with (let ((${name} …)) …) in the statement that uses it.`;
  return {
    code: "envelope/scope-confusion",
    verbosityKey: "envelope/scope-confusion#cross-scope",
    tier: "explain-route",
    fact,
    reason: "",
    script: "",
    terse: `\`${name}' was only ever locally bound (${when}) — re-declare it at top level or bind it locally where you use it.`,
  };
}

/** Build the scope-confusion door's ≥2-LOCAL special case (V's flag, spec header): X has been
 *  locally bound this way twice or more — a consistent style, not a one-off. Acknowledges both
 *  paths without prescribing one (never push a model with a working local-binding style toward
 *  global `(define)`). */
function repeatedLocalScopeDoor(name: string): Door {
  const fact =
    `\`${name}' is a local binding you've used before — it doesn't persist across statements. ` +
    `Either bind it in the same statement that uses it, or (define ${name} …) it at top level ` +
    `to reuse it across calls.`;
  return {
    code: "envelope/scope-confusion",
    verbosityKey: "envelope/scope-confusion#repeated-local",
    tier: "explain-route",
    fact,
    reason: "",
    script: "",
    terse: `\`${name}' is a local binding again — bind it in the statement that uses it, or (define ${name} …) at top level.`,
  };
}

/** THE SCOPE-CONFUSION CLASSIFIER — the LAST branch of the unbound-in-expr enrichment chain
 *  (manifold-tool.ts: tool-name (unboundInExprDoor's three tiers) → library-symbol (arrival's
 *  own polyglot-rich-errors, already riding in the raw message) → data-literal (also
 *  unboundInExprDoor) → THIS → bare fallthrough). Priority mirrors the spec's (a)/(b)/(c)/(d): a
 *  same-program cascade explanation wins over a cross-scope one (a name that ALSO happens to
 *  have local-binding history is still, first and foremost, explained by the failure in front of
 *  the model right now); ≥2 local occurrences win over exactly one (the "don't force a style"
 *  case is strictly more specific); zero of either ⇒ undefined (case (d), not this door's job). */
export function scopeConfusionDoor(input: ScopeConfusionInput): Door | undefined {
  if (input.topLevelDefineStatementNumber !== undefined) {
    return cascadeScopeDoor(input.name, input.firstErrorStatementNumber);
  }
  if (input.localBindingCallIndexes.length >= 2) {
    return repeatedLocalScopeDoor(input.name);
  }
  if (input.localBindingCallIndexes.length === 1) {
    return crossScopeDoor(input.name, input.currentCallIndex - input.localBindingCallIndexes[0]!);
  }
  return undefined;
}

// ─── envelope/signature-echo — echo the implicated tool's contract under a misuse error ───
// Measured problem: ~15% of eval errors are tool MISUSE (wrong kwarg name, dangling keyword,
// wrong arg type/shape) — the model gets the error but not the CONTRACT, so it guesses again.
// The manifold already holds every tool's one-line signature (ToolSignature.signatureText, the
// same lines the catalog renders); echoing the relevant one below the error teaches directly.
// This is a SIBLING of the unbound did-you-mean enrichment, gated to a DISJOINT error family:
// unbound-variable walls belong to that door; upstream EXECUTION errors (the tool ran, its args
// were fine) get nothing — echoing only ever fires on argument/validation/kwarg/arity failures
// that prevented or rejected the call.

/** Error-message shapes that mean "the CALL's arguments were wrong" — as opposed to a tool that
 *  ran and failed on domain grounds. Keyed on the OBSERVED families (probe against the real
 *  interpreter + a validating upstream): arrival's kwargs runtime, the `s/*` type-assertions, and
 *  an upstream JSON-Schema/zod argument rejection (MCP -32602, its plumbing frame already stripped
 *  by server.ts). Deliberately NOT matched — each owns its OWN teaching: the unbound-variable wall
 *  (the did-you-mean door), the attestation-required door, and any domain/execution prose.
 *
 *  The `Input validation error` entry is a downstream MCP SERVER's own tool-input rejection
 *  (the TS MCP SDK's `McpServer` helper throws exactly `Input validation error: Invalid
 *  arguments for tool <name>: <zod issues>` — verified against @modelcontextprotocol/sdk's
 *  `validateToolInput`); `\binvalid arguments\b` already matches that exact wording, so this
 *  entry is a deliberately WIDER, wording-independent net keyed on the SDK's own wrapper prefix
 *  alone — it still classifies correctly if a future SDK release rephrases the "invalid
 *  arguments" clause but keeps its "Input validation error:" preamble. Confirmed via the
 *  downstream-JSON-schema-rejection benchmark case (54% unrecovered before the Example: line
 *  landed, signature-echo.test.ts's "downstream -32602" cases) that this shape reaches
 *  `signatureEchoFor` with the SDK's `MCP error <code>: ` frame already stripped by
 *  server.ts's `stripJsonRpcFrame` (both stripped and unstripped forms match either way). */
const TOOL_MISUSE_SHAPES: readonly RegExp[] = [
  /kwargs call has /, // dangling keyword / arity at the kwargs boundary
  /^s\/(?:number|integer|string|boolean|object|array): expected /, // s/* type-assertion failure
  /\binvalid arguments\b/i, // upstream JSON-Schema/zod argument rejection
  /\brequired propert(?:y|ies)\b/i, // JSON-Schema "must have required property"
  /\bInput validation error\b/i, // the TS MCP SDK's downstream tool-input-rejection wrapper
];

/** True iff an error message is an argument/validation/kwarg/arity failure (see the shape list). */
export function isToolMisuseError(message: string): boolean {
  return TOOL_MISUSE_SHAPES.some((re) => re.test(message));
}

/** Whole scheme-symbol tokens in a source string. The charset recovers a qualified
 *  `slug_tool-name` symbol as ONE token (`\w` already covers `_`; `/` stays admitted too, for
 *  a model still writing the legacy namespaced shape), so exact set-membership against the
 *  bound names is a longest-match by construction — `toy_add` tokenizes whole, never as a bare
 *  `add`. */
const SYMBOL_TOKEN = /\w[\w./-]*/g;
const tokensOf = (source: string): Set<string> => new Set(source.match(SYMBOL_TOKEN));

/** Pick the ONE bound tool a failing statement implicates, or undefined when the choice is
 *  ambiguous (no false teaching). Candidates = bound tool names appearing as whole symbols in the
 *  statement source. Exactly one candidate ⇒ it. Several ⇒ only the one whose qualified OR bare
 *  name (read off `tools`, never re-split) the error message uniquely names; otherwise
 *  undefined (the task's "names neither → skip"). Zero candidates ⇒ undefined (e.g. a bare
 *  `(s/number "x")` — the validator is not a tool). */
export function implicatedTool(
  statement: string,
  message: string,
  boundToolNames: Iterable<string>,
  tools: ReadonlyMap<string, BoundTool>,
): string | undefined {
  const stmtTokens = tokensOf(statement);
  const candidates = [...boundToolNames].filter((name) => stmtTokens.has(name));
  if (candidates.length <= 1) return candidates[0];
  const msgTokens = tokensOf(message);
  const named = candidates.filter((name) => msgTokens.has(name) || msgTokens.has(tools.get(name)?.tool ?? name));
  return named.length === 1 ? named[0] : undefined;
}

/** The signature-echo decision for one failed statement: the implicated tool + its signature, or
 *  undefined when the error is not a misuse shape, no single tool is implicated, or that tool has
 *  no signature. The caller (manifold-tool.ts) appends `\nSignature: <signatureText>` and routes
 *  the telemetry line through DoorSession.echoSignature. */
export function signatureEchoFor(
  statement: string,
  message: string,
  signatureByName: ReadonlyMap<string, string>,
  tools: ReadonlyMap<string, BoundTool>,
  /** The misuse-shape gate — the strategy seam (strategies.ts's `IsMisuseErrorStrategy`): a
   *  positional-tuple consumer (arrival-mcp) matches a different error-message family. Defaults
   *  to {@link isToolMisuseError} — today's kwargs-world shapes, unchanged for every caller that
   *  doesn't pass an override. */
  isMisuseError: (message: string) => boolean = isToolMisuseError,
): { tool: string; signatureText: string } | undefined {
  if (!isMisuseError(message)) return undefined;
  const tool = implicatedTool(statement, message, signatureByName.keys(), tools);
  if (tool === undefined) return undefined;
  const signatureText = signatureByName.get(tool);
  return signatureText === undefined ? undefined : { tool, signatureText };
}

/** A manifold call whose expr is empty/whitespace-only — zero top-level forms. The terse
 *  line IS the previously-frozen contract string, so single-line consumers keep matching. */
export function emptyExprDoor(toolNaming: ToolNaming): Door {
  return {
    code: "envelope/empty-expr",
    tier: "explain-route",
    fact: `${toolNaming.argName} is empty — provide at least one Scheme expression.`,
    reason:
      "An empty program has zero top-level forms: evaluation would return nothing and read " +
      "as a silent success, which is worse than this error.",
    script:
      `Retry — call the ${toolNaming.toolName} tool with at least one form in ${toolNaming.argName}, e.g. ` +
      "(server_tool-name :key value); the tool description lists every bound symbol.",
    terse: `${toolNaming.argName} is empty — provide at least one Scheme expression.`,
  };
}

/** A call whose program argument is missing, or is neither a string nor an array of strings. */
export function invalidArgsDoor(program: unknown, toolNaming: ToolNaming): Door {
  const got =
    program === undefined ? `nothing (the ${toolNaming.argName} argument is missing)` : `${typeNameOf(program)}`;
  return {
    code: "envelope/invalid-args",
    tier: "explain-route",
    fact: `${toolNaming.argName} must be a string of Scheme source, or an array of such strings — got ${got}.`,
    reason: `The ${toolNaming.toolName} tool takes {${toolNaming.argName}: string | string[]}; every operation is written inside it.`,
    script: `Retry — call the ${toolNaming.toolName} tool with ${toolNaming.argName} = "(server_tool-name :key value)".`,
    terse: `${toolNaming.argName} must be a string or array of strings — got ${got}.`,
  };
}

function typeNameOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

// ─── the futility doors — the ONLY doors on a successful call (futility.ts) ───
// Shape-based, semantics-free: the FutilityTracker watches per-tool result hashes and, when a
// tool stops moving the model forward, queues one of these. They render via DoorSession.renderNote
// as `Note:` blocks appended to the manifold call's output — the tool RESULT itself is never
// touched (it already flowed into scheme dataflow); the note is pure advice to stop retrying.

/** TRIGGER 1 — a tool's last 3 calls returned effectively the same result despite ≥2 distinct
 *  argument sets: the tool is insensitive to input (degraded / rate-limited / bot-walled). */
export function futileRetryDoor(qualifiedName: string): Door {
  return {
    code: "envelope/futile-retry",
    tier: "explain-route",
    fact: `the last 3 calls to ${qualifiedName} returned effectively the same result despite different arguments`,
    reason: "the tool looks degraded or rate-limited right now — more retries will not change the outcome",
    script: `stop retrying ${qualifiedName}; work from the evidence you already gathered, take a different tool/route, or give your best final answer.`,
    terse: `${qualifiedName} is still returning the same result regardless of arguments — stop retrying it and work from what you have.`,
  };
}

/** TRIGGER 2 — the same tool was called twice in a row with the same arguments AND got the same
 *  result: a pure repeat that adds nothing the model does not already have above. */
export function duplicateCallDoor(qualifiedName: string): Door {
  return {
    code: "envelope/duplicate-call",
    tier: "explain-route",
    fact: `you already have this exact ${qualifiedName} result above — do not re-run identical calls; use the earlier result.`,
    reason: "",
    script: "",
    terse: `duplicate ${qualifiedName} call — use the earlier result above instead of re-running it.`,
  };
}

// ─── the output layer — per-session verbosity gate + follow-rate telemetry ───

/** Session = the manifold server process lifetime. Holds the ONE per-session seen-set
 *  (Rule 4's verbosity gate, keyed per lesson SHAPE via `door.verbosityKey ?? door.code` — a
 *  render concern, deliberately outside the door generators) and the follow-rate ledger (Rule
 *  5). One instance per built server; it survives tools/listChanged rebuilds. */
export class DoorSession {
  /** Lesson SHAPES already introduced this session (keyed by `door.verbosityKey ?? door.code`
   *  — finer than DoorCode, so distinct shapes sharing one code each keep their own slot). */
  private readonly seen = new Set<string>();
  private readonly pendingFollow = new Map<string, DoorCode>();
  private seq = 0;

  constructor(private readonly log: (line: string) => void = (line) => console.error(line)) {}

  /** Render a door for output: logs the telemetry line, arms follow-tracking for the
   *  name-level doors, and picks verbose (first occurrence of this lesson SHAPE this session,
   *  keyed `verbosityKey ?? code`) or terse (every later one). Always returns the frozen
   *  `Error: ...` contract shape. */
  render(door: Door, tool: string): string {
    this.seq += 1;
    this.log(JSON.stringify({ door: door.code, seq: this.seq, tool }));
    if (door.code === "envelope/bare-tool-call" || door.code === "envelope/unknown-tool") {
      this.pendingFollow.set(tool, door.code);
    }
    const key = door.verbosityKey ?? door.code;
    const verbose = !this.seen.has(key);
    this.seen.add(key);
    return verbose ? `Error: ${door.fact}\n  Why: ${door.reason}\n  ${door.script}` : `Error: ${door.terse}`;
  }

  /** Render a NON-ERROR advisory door (the futility doors) for output. Identical machinery to
   *  {@link render} — same telemetry line, same per-session verbosity gate (verbose on a lesson
   *  SHAPE's first occurrence, terse after) — with ONE deliberate difference: the prefix is `Note: `, not
   *  `Error: `. The manifold call SUCCEEDED (the tool result is valid and already in the output
   *  blocks); a futility door is advice, not a rejection, so it must not read as an error to a
   *  caller matching the frozen `Error: ` contract. `reason`/`script` are optional here (the
   *  duplicate-call door carries neither) — a Why/script line is emitted only when non-empty, so
   *  the note never renders a dangling `Why:` with nothing after it. */
  renderNote(door: Door, tool: string): string {
    this.seq += 1;
    this.log(JSON.stringify({ door: door.code, seq: this.seq, tool }));
    const key = door.verbosityKey ?? door.code;
    const verbose = !this.seen.has(key);
    this.seen.add(key);
    if (!verbose) return `Note: ${door.terse}`;
    const why = door.reason ? `\n  Why: ${door.reason}` : "";
    const script = door.script ? `\n  ${door.script}` : "";
    return `Note: ${door.fact}${why}${script}`;
  }

  /** Inline enrichment of an in-expr error (envelope/unbound-in-expr): the caller has ALREADY
   *  emitted the frozen `Error: Unbound variable `X'` first line — this returns ONLY the indented
   *  teaching suffix to append below it, so the H-4 first-line contract is preserved by
   *  construction. Verbosity rides the same per-session gate as render() (Rule 4): the lesson
   *  SHAPE's first occurrence gets the full teaching (fact + optional second line), later ones the terse
   *  one-liner. Telemetry is logged (Rule 6); follow-tracking is NOT armed — the attempted symbol
   *  X still appears in the same failing expr, so `observeSuccess(expr)` on a partial-success call
   *  would false-positive on it. */
  enrichInline(door: Door, attempted: string): string {
    this.seq += 1;
    this.log(JSON.stringify({ door: door.code, seq: this.seq, tool: attempted }));
    const key = door.verbosityKey ?? door.code;
    const verbose = !this.seen.has(key);
    this.seen.add(key);
    if (verbose) return door.reason ? `\n  ${door.fact}\n  ${door.reason}` : `\n  ${door.fact}`;
    return `\n  ${door.terse}`;
  }

  /** SIGNATURE-ECHO render + telemetry (mirrors {@link enrichInline}'s logging): emits one
   *  `{door, seq, tool}` stderr line under the new `envelope/signature-echo` code and returns the
   *  suffix to append below a preserved tool-misuse error's first line. NO verbosity gate — the
   *  signature IS the teaching and has no terser form, so re-showing it on each misuse of the same
   *  tool is the intent (the model still has the wrong contract until it stops). The frozen first
   *  line (H-4) is preserved by the caller; this only ever adds a line below it.
   *
   *  `example` (V's design, 2026-07-05) is a synthesized working call (example-call.ts) for the
   *  SAME tool, APPENDED as its own `Example: ` line below `Signature: ` — never replacing it.
   *  Optional so a caller with no schema map (or omitting it entirely) keeps today's
   *  Signature-only shape byte-for-byte. */
  echoSignature(tool: string, signatureText: string, example?: string): string {
    this.seq += 1;
    this.log(JSON.stringify({ door: "envelope/signature-echo", seq: this.seq, tool }));
    const exampleLine = example === undefined ? "" : `\nExample: ${example}`;
    return `\nSignature: ${signatureText}${exampleLine}`;
  }

  /** BYPASS AUTO-EXEC telemetry (mirrors {@link echoSignature}'s logging-without-rejection
   *  shape): logs one `{door, seq, tool, resolvedTo}` stderr line under
   *  `envelope/bypass-autoexec` when a direct (bypass) call was translated and executed
   *  instead of taught. `tool` is the ATTEMPTED name (what a "bypass attempts" consumer
   *  already counts via envelope/bare-tool-call/envelope/unknown-tool); `resolvedTo` is the
   *  qualified tool it ran as. No verbosity gate — this is a distinct per-call measurement,
   *  not a repeated concept intro. Returns nothing to render: the call's own result (success
   *  or failure) travels untouched; only the caller's one advisory line is added around it. */
  logBypassAutoExec(attempted: string, resolvedTo: string): void {
    this.seq += 1;
    this.log(JSON.stringify({ door: "envelope/bypass-autoexec", seq: this.seq, tool: attempted, resolvedTo }));
  }

  /** TYPE-HINT telemetry (doc §3/G7): every lens outcome logs exactly one structured line
   *  under the `envelope/type-hint` door. Mirrors the other stderr telemetry sinks — the
   *  manifold's benches parse these lines; no verbosity gate applies (each is a distinct
   *  measurement of one lens run, not a repeated concept intro). The caller (deliver.ts) owns
   *  the event shape; this is the ONE seam onto the session's private log sink. */
  logTypeHint(event: TypeHintTelemetry): void {
    this.log(JSON.stringify(event));
  }

  /** Self-observed "followed" (Rule 5): a successful manifold call whose expr contains a
   *  door'ed tool name means the caller routed through the door. "Followed" = the retry
   *  RAN successfully — mere acknowledgment never logs. */
  observeSuccess(expr: string): void {
    for (const [tool, code] of this.pendingFollow) {
      if (expr.includes(tool)) {
        this.log(JSON.stringify({ "door-followed": code, tool }));
        this.pendingFollow.delete(tool);
      }
    }
  }

  /** Serialize the session's dedup/follow/telemetry-sequence state — session-export primitive
   *  (session-store.ts). The injected `log` sink is deliberately excluded (it is re-supplied by
   *  the constructor on restore, never data). */
  exportState(): { seen: readonly string[]; pendingFollow: readonly (readonly [string, DoorCode])[]; seq: number } {
    return { seen: [...this.seen], pendingFollow: [...this.pendingFollow], seq: this.seq };
  }

  /** Replace the session's dedup/follow/telemetry-sequence state wholesale (session restore) —
   *  a full rehydration, never a merge. */
  importState(state: {
    seen: readonly string[];
    pendingFollow: readonly (readonly [string, DoorCode])[];
    seq: number;
  }): void {
    this.seen.clear();
    for (const key of state.seen) this.seen.add(key);
    this.pendingFollow.clear();
    for (const [tool, code] of state.pendingFollow) this.pendingFollow.set(tool, code);
    this.seq = state.seq;
  }
}
