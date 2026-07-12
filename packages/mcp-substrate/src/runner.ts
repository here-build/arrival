// runner — the central stateful orchestrator for the doors teaching system.
//
// `createDoorsRunner(options)` returns a `DoorsRunner` with a `run(input)` method that executes
// Scheme expressions against an assembled ambient + persistent lexical scope, enriches errors
// with structured teaching doors, tracks session history, applies futility detection, and
// (optionally) delivers type hints.
//
// The runner owns cross-call state (via injected `session` and `tracker`) so that per-process
// teaching state survives world rebuilds (e.g. tools/listChanged). It is env-lifecycle-agnostic
// and model-agnostic.

import { APair, execState, parse, theVoid, tokenize, type LexicalScope, type SchemeValue } from "@here.build/arrival";
import type { AssembledAmbient } from "@here.build/arrival/env";
import { toSExprString, toSExprStringWithElisions, type ElisionRecord } from "@here.build/arrival-serializer";

import { ArgsFailureTracker, type ArgsFailureState } from "./args-failure-tracker.js";
import { localizeFailingParam } from "./args-misuse.js";
import { renderArgsMisuseTeaching, renderFullSchemaTeaching } from "./args-misuse-door.js";
import type { AttachmentSink } from "./attachment-sink.js";
import type { BoundTool, ToolNaming } from "./bound-tool.js";
import { type CalibrationOptions, DEFAULT_CALIBRATION } from "./calibration.js";
import type { ContentBlock } from "./content-block.js";
import {
  DoorSession,
  emptyExprDoor,
  importDoor,
  scopeConfusionDoor,
  signatureEchoFor,
  unboundInExprDoor,
  type DoorCode,
} from "./doors.js";
import { FutilityTracker, type FutilityState } from "./futility.js";
import { observationCaps, renderObservationWithElisions } from "./render-observation.js";
import {
  createLocalBindingTracker,
  createSessionHistory,
  type LocalBindingState,
  type SessionHistory,
  type SessionHistoryEntry,
} from "./session-history.js";
import type { AsyncSessionStore } from "./session-store.js";
import { analyzeStatement, type StatementFacts } from "./statement-facts.js";
import type { DoorStrategies } from "./strategies.js";
import type { ToolJsonSchema } from "./tool-schema.js";
import { createContextRing, type SerializableContextRing } from "./type-hints/context-ring.js";
import { deliverTypeHints } from "./type-hints/deliver.js";
import type { TypeHintLens, TypeHintsMode } from "./type-hints/types.js";

/** Extra grace period for the outer timeout race. Used only when evaluation is parked inside
 * a host await (e.g. a stuck upstream tool) that the in-band budget check cannot reach. */
const PARKED_GRACE_MS = 250;

const UNBOUND_VARIABLE = /Unbound variable [`']?([^`'\s]+)/;

const timeoutMessage = (timeoutMs: number): string =>
  `evaluation timed out after ${timeoutMs}ms — the expr did not finish within the evaluation budget. ` +
  `Likely an infinite loop/recursion, or a stuck tool call. The environment is still usable: ` +
  `fix the runaway expression and try again, splitting the work into smaller exprs if needed.`;

// ─── REPL statement splitting ───
const isOpen = (tok: string): boolean =>
  tok === "(" || tok === "[" || tok === "{" || (tok.startsWith("#") && !tok.startsWith("#\\") && tok.endsWith("("));
const CLOSE = new Set([")", "]", "}"]);
const QUOTE_PREFIX = new Set(["'", "`", ",", ",@"]);
const isSkippable = (tok: string): boolean =>
  /^\s+$/.test(tok) || tok.startsWith(";") || tok.startsWith("#|") || tok.startsWith("#;");

function splitTopLevel(source: string): string[] {
  const tokens = tokenize(source, true) as { token: string; offset: number }[];
  const starts: number[] = [];
  let depth = 0;
  let between = true;
  for (const { token, offset } of tokens) {
    if (isSkippable(token)) continue;
    if (between) {
      starts.push(offset);
      between = false;
    }
    if (isOpen(token)) depth++;
    else if (CLOSE.has(token)) {
      if (depth > 0) depth--;
      if (depth === 0) between = true;
    } else if (depth === 0 && !QUOTE_PREFIX.has(token)) {
      between = true;
    }
  }
  return starts.map((s, i) => source.slice(s, starts[i + 1] ?? source.length).trim()).filter(Boolean);
}

// ─── Form display text ───
//
// The execution/analysis loop works directly on `forms` (the real parsed `SchemeValue[]` from
// arrival's reader). `splitTopLevel` is retained only to produce human-readable text for
// session history, context rings, signature echoes, and type hints.
//
// Alignment: `forms.length` may differ from the text split count because `#;` datum comments
// are dropped by the real parser but still appear in the lexer split. The call site checks
// `statements.length === forms.length` before trusting index alignment; otherwise it falls back
// to location-anchored slicing or `toSExprString`. Display text is never used for execution or
// semantic analysis.

/** The next form (from `fromIndex` onward) that carries `[LOCATION]` metadata, or `undefined` if
 *  none of the remaining forms have one. Looking ahead past location-less forms (rather than only
 *  checking the IMMEDIATE next form) guarantees a form's display-text slice never crosses into a
 *  LATER form's own located text, however many location-less atoms/vectors sit in between. */
function nextLocatedOffset(forms: readonly SchemeValue[], fromIndex: number): number | undefined {
  for (let i = fromIndex; i < forms.length; i++) {
    const f = forms[i];
    if (f instanceof APair) {
      const loc = f.getLocation();
      if (loc !== undefined) return loc.offset;
    }
  }
  return undefined;
}

/** Cosmetic display text for one form — NEVER consulted by `exec`/`analyzeStatement` (both read
 *  `forms` directly at the call site). Prefers a location-anchored slice into the original `expr`
 *  (preserving the statement's exact original formatting/comments); falls back to `toSExprString`
 *  for a form with no location metadata. */
function displayTextFor(form: SchemeValue, index: number, forms: readonly SchemeValue[], expr: string): string {
  if (form instanceof APair) {
    const loc = form.getLocation();
    if (loc !== undefined) {
      const end = nextLocatedOffset(forms, index + 1) ?? expr.length;
      return expr.slice(loc.offset, end).trim();
    }
  }
  return toSExprString(form);
}

/** Find the statement number of an earlier top-level `(define name ...)` for the given name. */
function topLevelDefineStatementNumber(
  name: string,
  facts: readonly StatementFacts[],
  beforeIndex: number,
): number | undefined {
  for (let i = 0; i < beforeIndex; i++) {
    if (facts[i]!.definedName === name) return i + 1;
  }
  return undefined;
}

/** True if the error is the bare "Unbound variable" form for a library symbol (not a tool). */
function isLibraryEnriched(raw: string, name: string): boolean {
  const bareWall = `Unbound variable \`${name}'`;
  return raw.startsWith(bareWall) && raw.length > bareWall.length;
}

/** The trailing `;; Note:` block for a call that middle-elided one or more arrays/entries
 *  (serializer-elision plan §6) — ONE block per `run()` call, one line per elided collection,
 *  emitted regardless of how many forms/observations contributed. Wording is contractual:
 *  say "not rendered", never "compacted"/"truncated" — the whole point is that the model
 *  must not read the shown sample as complete. */
function renderElisionNote(elisions: readonly ElisionRecord[]): string {
  const lines = elisions.map((e) => {
    const shown = e.total - e.notRendered;
    const same = e.shownShape === e.hiddenShape ? " (same shape as shown)" : "";
    return (
      `;;   array of ${e.total} items: ${e.notRendered} not rendered (${shown} shown). ` +
      `shown: ${e.shownShape}; not rendered: ${e.hiddenShape}${same}`
    );
  });
  return [
    ";; Note: arrays were shortened for display — the shown items are NOT the full result.",
    ...lines,
  ].join("\n");
}

export interface RunInput {
  expr: string;
  /** The assembled capability base (stdlib + every bound tool) this call resolves
   *  builtins/tools through — caller-owned, never disposed here. */
  ambient: AssembledAmbient;
  /** The persistent lexical root this call's top-level `define`s land in. Pass the SAME
   *  scope object across calls for REPL-style multi-statement accumulation (a session
   *  owner mints one via `LexicalScope.fresh()` and holds it for the world's lifetime). */
  scope: LexicalScope;
  tools: ReadonlyMap<string, BoundTool>;
  /** Per-call override, already clamped to [calibration.responseSizeMinChars,
   *  calibration.responseSizeMaxChars] by the caller. */
  responseSizeMaxChars?: number;
  /** Per-call evaluation time budget in ms (the WHOLE multi-statement call), already
   *  clamped by the caller. Absent ⇒ `calibration.defaultEvalTimeoutMs`. Same per-call-only,
   *  never-mutates-the-world-default shape as `responseSizeMaxChars`. */
  timeoutMs?: number;
  /** Per-call override for the attachment pass-through quota (manifold's `response-attachments`
   *  arg); irrelevant to a caller with a no-op `AttachmentSink`. */
  attachmentQuota?: number;
  /** OPTIONAL, ADDITIVE — the roster used ONLY to seed session-history/context-ring's
   *  tool-valued-define detection (the "have I seen a real tool call in this define's source"
   *  heuristic). Distinct from `tools` because manifold's pre-split behavior kept these two
   *  concerns independent: schema/roster recovery was ALWAYS derived straight off the env
   *  (bind.ts's `toolSchemasForEnv` WeakMap), while `tools`-driven unbound-in-expr resolution
   *  and signature-echo were an explicit OPT-IN the caller had to wire in separately (a
   *  frozen contract — see arrival-manifold's `signature-echo.test.ts`, "a tool built WITHOUT a
   *  signature map never echoes"). Reusing `tools` for both would silently turn that opt-in into
   *  an always-on whenever a caller's `env` merely has real bound tools, which is exactly the
   *  regression this field avoids. Defaults to `tools.keys()` when omitted — a caller that
   *  passes a real `tools` registry needs nothing extra. */
  knownToolNames?: Iterable<string>;
}

export interface RunResult {
  content: readonly ContentBlock[];
  isError?: boolean;
}

export interface DoorsRunnerOptions {
  toolNaming: ToolNaming;
  strategies: DoorStrategies;
  attachmentSink: AttachmentSink;
  calibration?: Partial<CalibrationOptions>;
  sessionStore?: AsyncSessionStore;
  sessionId?: string;
  /** Observation rendering mode. "braces" (default) uses `{:k v ...}` / `[a b ...]`.
   *  "sexpr" uses the constructor form `(dict :k v ...)` / `(list a b ...)`. */
  rendering?: "braces" | "sexpr";
  /** Optional type-hints delivery configuration. When present and not "off", type diagnostics
   *  are delivered as trailing content after statement results. */
  typeHints?: { mode: TypeHintsMode; lens: TypeHintLens };
  /** Optional shared `DoorSession` (controls per-shape verbosity and follow telemetry).
   *  Injected by the host so teaching state survives `DoorsRunner` reconstruction on world
   *  rebuilds. If omitted, a private instance is used. */
  session?: DoorSession;
  /** Optional shared `FutilityTracker`. If omitted, futility doors are disabled for this runner. */
  tracker?: FutilityTracker;
  /** Optional shared `ArgsFailureTracker` (args-misuse escalation state, design doc §2.4).
   *  UNLIKE `tracker`, a private instance is constructed when omitted (the `session` precedent,
   *  not the futility one): escalation is intrinsic to the args-misuse door's correctness —
   *  without state every failure would render the lean L1 forever. Inject the host's instance
   *  when reset-on-success must fire (the binder sees tool successes, the runner doesn't) or
   *  when state must survive a world rebuild. */
  argsTracker?: ArgsFailureTracker;
}

/** The serializable teaching state for a `DoorsRunner`.
 *
 *  - `history`, `futility`, `localBindings`, `doorSession`, `contextRing` are the live teaching
 *    state.
 *  - `cache` is reserved for future replay-cache support for tool-valued defines.
 *  - Older blobs may contain a `competence` key (removed); it is ignored on restore. */
interface SessionBlob {
  v: 1;
  history: readonly SessionHistoryEntry[];
  cache: Record<string, string>;
  futility: FutilityState;
  localBindings: LocalBindingState;
  doorSession: { seen: readonly string[]; pendingFollow: readonly (readonly [string, DoorCode])[]; seq: number };
  contextRing: readonly (readonly [string, string])[];
  /** ADDITIVE (design doc §2.4): args-misuse escalation counters. Absent in older blobs ⇒
   *  empty tracker on restore — no version bump, the `competence`-key tolerance precedent. */
  argsFailures?: ArgsFailureState;
}

/** Session-scoped stateful runner — NOT a pure function. Holds door session, local-binding
 *  tracker, session-history, context-ring, and call/generation counters across calls to `run()`. */
export interface DoorsRunner {
  run(input: RunInput): Promise<RunResult>;
  /** Serializes the FULL teaching-state bundle to one JSON blob (history, cache, futility rings,
   *  DoorSession dedup, context-ring) — everything `AsyncSessionStore` round-trips. */
  exportSession(): string;
  restoreSession(blob: string): void;
}

export function createDoorsRunner(options: DoorsRunnerOptions): DoorsRunner {
  const calibration: CalibrationOptions = { ...DEFAULT_CALIBRATION, ...options.calibration };
  const { toolNaming, strategies, attachmentSink } = options;

  const session = options.session ?? new DoorSession();
  const tracker = options.tracker;
  const argsTracker = options.argsTracker ?? new ArgsFailureTracker();
  const localBindingTracker = createLocalBindingTracker();
  let callCounter = 0;
  let generation = 0;

  // Session history and context ring need the tool roster at construction time for
  // tool-valued-define detection. Since the runner is env-lifecycle-agnostic (tools arrive
  // fresh per call), both are seeded lazily from the first call's roster and reused. If the
  // roster varies per call, it is frozen to whatever was seen first.
  let sessionHistory: SessionHistory | undefined;
  let contextRing: SerializableContextRing | undefined;
  let rosterSeeded = false;
  function ensureRosterSeeded(knownToolNames: Iterable<string>): void {
    if (rosterSeeded) return;
    rosterSeeded = true;
    const names = [...knownToolNames];
    sessionHistory = createSessionHistory(names);
    if (options.typeHints !== undefined) contextRing = createContextRing(names);
  }

  async function run(input: RunInput): Promise<RunResult> {
    ensureRosterSeeded(input.knownToolNames ?? input.tools.keys());
    const history = sessionHistory!;

    const thisCallIndex = ++callCounter;
    attachmentSink.beginCall(input.attachmentQuota);

    const expr = input.expr;
    if (expr.trim() === "") {
      return {
        content: [{ type: "text", text: session.render(emptyExprDoor(toolNaming), toolNaming.toolName) }],
        isError: true,
      };
    }

    const callMaxTotalChars = input.responseSizeMaxChars ?? calibration.observationMaxTotalChars;
    const timeoutMs = input.timeoutMs ?? calibration.defaultEvalTimeoutMs;

    // Middle-elision (serializer-elision plan) is OPT-IN via `calibration.observationElision` —
    // `render` always returns `elisions` (empty when the knob is unset), so accumulation below
    // is unconditional and costs nothing when the feature is off.
    const render = (value: unknown, maxTotalCharsOverride?: number): { text: string; elisions: ElisionRecord[] } => {
      const effectiveMax = maxTotalCharsOverride ?? calibration.observationMaxTotalChars;
      return options.rendering === "sexpr"
        ? toSExprStringWithElisions(value, observationCaps(effectiveMax, calibration.observationElision))
        : renderObservationWithElisions(value, { maxTotalChars: effectiveMax, ...calibration.observationElision });
    };

    // Derived FRESH from this call's tools (never cached across calls — RunInput.tools is the
    // env-lifecycle-agnostic source of truth for the current world's roster).
    const toolSchemas: ReadonlyMap<string, ToolJsonSchema | undefined> = new Map(
      [...input.tools].map(([name, tool]) => [name, tool.schema]),
    );
    const signatureByName: ReadonlyMap<string, string> = new Map(
      [...input.tools].map(([name, tool]) => [name, tool.signature().signatureText]),
    );

    const controller = new AbortController();
    const deadline = Date.now() + timeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutResult = (): RunResult => {
      controller.abort();
      return { content: [{ type: "text", text: `Error: ${timeoutMessage(timeoutMs)}` }], isError: true };
    };
    try {
      let forms: SchemeValue[];
      try {
        forms = await parse(expr);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text:
                `Error: ${message} — check bracket balance near that point (a stray or missing closer ` +
                "is the usual cause), fix, and resend.",
            },
          ],
          isError: true,
        };
      }

      if (forms.length === 0) {
        return { content: [] };
      }

      // See the FORM DISPLAY TEXT block above `splitTopLevel` for the alignment rationale.
      const statements = splitTopLevel(expr);
      const textAligned = statements.length === forms.length;
      const displayText = forms.map((form, i) => (textAligned ? statements[i]! : displayTextFor(form, i, forms, expr)));

      const statementFacts = forms.map((form) => analyzeStatement(form));
      localBindingTracker.record(
        statementFacts.flatMap((f) => f.localBindings),
        thisCallIndex,
      );

      const parked = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs + PARKED_GRACE_MS);
      });

      const blocks: ContentBlock[] = [];
      let failures = 0;
      const erroredStatementIndexes: number[] = [];
      // Names this program binds into the persistent session scope. Collected to lead the
      // response with a persistence note (below) — the void-result affordance fix: a program
      // ending in `(define x (search …))` otherwise renders NOTHING (the void `define` result
      // is filtered at `!== theVoid`), which a model reads as "the search returned empty" and
      // confabulates from (MCP-Atlas 2026-07-11 forensics, task …c909). Announcing the binding
      // both kills that trap and teaches cross-call persistence proactively.
      const introduced: string[] = [];
      // Elisions collected across EVERY rendered observation this call, from every form —
      // rendered as ONE trailing `;; Note:` block below (never per-array, never per-form).
      const allElisions: ElisionRecord[] = [];

      for (const [index, form] of forms.entries()) {
        const statementText = displayText[index]!;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return timeoutResult();
        try {
          // COMPLEX tier on purpose: the runner is JS-side TOOLING, not a membrane exit.
          // `exec` (SIMPLE tier) toJS-unwraps every result, which breaks BOTH consumers
          // downstream — the `!== theVoid` filter (box identity gone: void renders as a
          // spurious observation) and the serializer's provenance-aware rendering
          // (ASymbol/AString/Values duck-typing sees plain JS instead of boxed values).
          // `execState` hands back the boxed per-form values this loop actually renders.
          const running = execState(form, {
            ambient: input.ambient,
            scope: input.scope,
            budgetMs: remaining,
            heapBudget: calibration.heapBudgetPerForm,
            signal: controller.signal,
          });
          const raced = await Promise.race([running, parked]);
          if (raced === "timeout") {
            const result = timeoutResult();
            running.catch(() => {});
            return result;
          }
          const facts = statementFacts[index]!;
          for (const r of raced.values) {
            if (r === theVoid) continue;
            const { text, elisions } = render(r, callMaxTotalChars);
            blocks.push({ type: "text", text });
            allElisions.push(...elisions);
          }
          if (facts.definedName !== undefined) {
            history.push(facts.definedName, statementText);
            contextRing?.push(facts.definedName, statementText);
            introduced.push(facts.definedName);
          }
        } catch (error) {
          erroredStatementIndexes.push(index);
          const raw = error instanceof Error ? error.message : String(error);
          if (raw.includes("execution budget exceeded")) return timeoutResult();
          let text = `Error: ${raw}`;
          const unbound = UNBOUND_VARIABLE.exec(raw);
          if (unbound) {
            const attempted = unbound[1]!;
            const qualifiedToolNames = [...signatureByName.keys()];
            const door = unboundInExprDoor(
              attempted,
              qualifiedToolNames,
              input.tools,
              toolNaming,
              toolSchemas,
              calibration.doorsTier3Top,
            );
            if (door) {
              text += session.enrichInline(door, attempted);
            } else if (!isLibraryEnriched(raw, attempted)) {
              // THE IMPORT-FORM DOOR (doors.ts's `importDoor`) — consulted after unboundInExprDoor
              // (a tool literally named `import`/`scheme` is implausible, but a tool-resolution
              // door still takes precedence by design) and before scopeConfusionDoor (an
              // import/scheme unbound was never top-level-defined or locally bound by the model,
              // so that classifier would fall through to undefined anyway — this catches it first
              // with the actually-relevant lesson instead of leaving the bare wall untaught).
              const importForm = importDoor(attempted);
              if (importForm) {
                text += session.enrichInline(importForm, attempted);
              } else {
                const scopeDoor = scopeConfusionDoor({
                  name: attempted,
                  topLevelDefineStatementNumber: topLevelDefineStatementNumber(attempted, statementFacts, index),
                  firstErrorStatementNumber: Math.min(...erroredStatementIndexes) + 1,
                  localBindingCallIndexes: localBindingTracker.occurrences(attempted),
                  currentCallIndex: thisCallIndex,
                });
                if (scopeDoor) text += session.enrichInline(scopeDoor, attempted);
              }
            }
          } else {
            // THE ARGS-MISUSE PIPELINE (design doc §3 hook #2). Gated by the same
            // signature-echo decision as before (misuse shape + exactly one implicated tool
            // + a known signature — the strategies.ts seams a positional consumer overrides).
            // When the failure LOCALIZES to one param (args-misuse.ts, fed by the binder's
            // membrane metadata via strategies.argsOfError), the L1/L2/L3 teaching replaces
            // the generic Example line — the model's own call beats a stub — and `Signature:`
            // still rides below it. When it doesn't, today's Signature + Example fallback is
            // byte-identical (the do-no-harm guard), with the ⊥ counter escalating a
            // repeatedly-unlocalizable tool to the full-schema backstop at L2+.
            const echo = signatureEchoFor(statementText, raw, signatureByName, input.tools, strategies.isMisuseError);
            if (echo) {
              const schema = toolSchemas.get(echo.tool);
              const metadata = strategies.argsOfError?.(error);
              const sentArgs = metadata?.qualifiedName === echo.tool ? metadata.sentArgs : undefined;
              const localized = localizeFailingParam(raw, sentArgs, schema);
              if (localized) {
                const level = argsTracker.recordFailure(echo.tool, localized.path);
                const body = renderArgsMisuseTeaching({ qualifiedName: echo.tool, sentArgs, localized, level });
                text += session.appendArgsTeaching(echo.tool, localized.path.join("."), level, body);
                text += session.echoSignature(echo.tool, echo.signatureText);
              } else {
                const level = argsTracker.recordFailure(echo.tool, undefined);
                const example = strategies.synthesizeExample(echo.tool, schema);
                text += session.echoSignature(echo.tool, echo.signatureText, example);
                if (level >= 2) {
                  text += session.appendArgsTeaching(echo.tool, "⊥", level, renderFullSchemaTeaching(echo.tool, schema));
                }
              }
            }
          }
          blocks.push({ type: "text", text });
          failures += 1;
        }
      }

      // Lead with the persistence note when this program bound anything into session scope
      // (see `introduced` above). A `#|…|#` reader block comment: inert if pasted back (the
      // "a printed result is valid input again" invariant holds), and it renders the binding
      // FACT even when every bound form was a void `define` with no other observation — the
      // void-result-trap fix. Deduped, declared order.
      if (introduced.length > 0) {
        const names = [...new Set(introduced)].join(", ");
        blocks.unshift({
          type: "text",
          text: `#|introduced ${names}; now available for the rest of this session|#`,
        });
      }

      // ONE trailing note for every array/entries collection middle-elided this call (any
      // form, any observation) — placed AFTER the form results, BEFORE the futility doors
      // below (serializer-elision plan §6). Never emitted when nothing elided (the
      // `observationElision` calibration knob is off, or every observation fit).
      if (allElisions.length > 0) {
        blocks.push({ type: "text", text: renderElisionNote(allElisions) });
      }

      if (tracker) {
        for (const { tool, door } of tracker.drainPending()) {
          blocks.push({ type: "text", text: session.renderNote(door, tool) });
        }
      }

      if (options.typeHints !== undefined && options.typeHints.mode !== "off") {
        const callSeq = ++generation;
        const trailing = await deliverTypeHints({
          lens: options.typeHints.lens,
          mode: options.typeHints.mode,
          programSource: expr,
          contextDefines: contextRing?.entries() ?? [],
          statements: displayText,
          erroredStatementIndexes,
          callSeq,
          isLatest: () => callSeq === generation,
          logTelemetry: (event) => session.logTypeHint(event),
        });
        for (const block of trailing) blocks.push(block);
      }

      const note = attachmentSink.drainNote();
      if (note !== undefined) blocks.push({ type: "text", text: note });
      for (const block of attachmentSink.drainBlocks()) blocks.push(block);

      if (failures === forms.length) return { content: blocks, isError: true };
      session.observeSuccess(expr);
      return { content: blocks };
    } finally {
      clearTimeout(timer);
    }
  }

  function exportSession(): string {
    ensureRosterSeeded([]);
    const blob: SessionBlob = {
      v: 1,
      history: sessionHistory!.entries(),
      cache: {},
      futility: tracker?.exportState() ?? [],
      localBindings: localBindingTracker.exportState(),
      doorSession: session.exportState(),
      contextRing: contextRing?.exportEntries() ?? [],
      argsFailures: argsTracker.exportState(),
    };
    return JSON.stringify(blob);
  }

  function restoreSession(blob: string): void {
    const parsed = JSON.parse(blob) as SessionBlob;
    ensureRosterSeeded([]);
    sessionHistory!.restoreEntries(parsed.history);
    tracker?.importState(parsed.futility);
    localBindingTracker.importState(parsed.localBindings);
    session.importState(parsed.doorSession);
    contextRing?.restoreEntries(parsed.contextRing);
    argsTracker.importState(parsed.argsFailures ?? { entries: [] });
  }

  return { run, exportSession, restoreSession };
}
