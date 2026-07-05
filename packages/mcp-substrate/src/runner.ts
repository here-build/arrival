// runner — the doors-steering runner's ONE stateful orchestrator: `createDoorsRunner(options)`
// builds a `DoorsRunner` whose `run(input)` is a behavior-preserving port of arrival-manifold's
// `manifold-tool.ts` `call()` method (commit history: the errors-as-doors envelope, competence v2,
// futility doors, session-history/scope-confusion tracking, type-hints delivery, attachments).
// This file is Phase 2 of docs/working-proposals/arrival-manifold-package-split-2026-07-05.md — the
// integration step wiring Track A (session-state) + Track B (door-generation), both already copied
// verbatim into this package's sibling modules in Phase 1.
//
// FROZEN-INTERFACE EXTENSIONS (found necessary during this port, not silently papered over — see
// the migration's own commit/PR notes for the full account):
//   • `DoorsRunnerOptions.rendering` — manifold's `"braces" | "sexpr"` observation-rendering
//     switch (config.ts/bin.ts, live and tested) has no other home: the CHOICE of renderer is
//     runner-owned (it renders every statement's result inside the statement loop), but neither
//     `CalibrationOptions` (numeric-only, by its own doc) nor the original 6-field
//     `DoorsRunnerOptions` had a slot for it.
//   • `DoorsRunnerOptions.typeHints` — the whole type-hints delivery subsystem (Ring 1-3:
//     context-ring, spine-lens, deliverTypeHints) is exercised entirely inside `call()`'s
//     statement-loop tail in the original, but the frozen interface set had no field carrying a
//     `{mode, lens}` pair into the runner at all.
//   • `DoorsRunnerOptions.session` / `.tracker` — server.ts constructs ONE `DoorSession` /
//     `FutilityTracker` per SERVER PROCESS specifically so verbosity-gate state and futility rings
//     SURVIVE a tools/listChanged world rebuild (its own header comment says so explicitly). Since
//     a rebuild in the new architecture reconstructs a fresh `DoorsRunner` (manifold-tool.ts's
//     wrapper builds one per `createManifoldTool` call, mirroring today's per-world
//     `createManifoldTool` call), an un-injectable internal `DoorSession`/`FutilityTracker` would
//     silently reset that state on every rebuild — a real behavior regression the original design
//     explicitly guards against. Both are optional, additive, and structurally mirror the existing
//     `attachmentSink` injection (already a required field) — omitting them reproduces a fresh,
//     private instance exactly as `manifold-tool.ts`'s own `options.session ?? new DoorSession()`
//     did.
// All four are additive optional fields; every existing typed consumer of the narrower
// `DoorsRunnerOptions` shape (the Phase-0 frozen-interface skeleton tests) still type-checks.

import { exec, parse, theVoid, tokenize, type SchemeEnv } from "@here.build/arrival";
import { toSExprString } from "@here.build/arrival-serializer";

import type { AttachmentSink } from "./attachment-sink.js";
import type { BoundTool, ToolNaming } from "./bound-tool.js";
import { type CalibrationOptions, DEFAULT_CALIBRATION } from "./calibration.js";
import { createCompetenceTracker, type CompetenceState, type TriggerClass } from "./competence.js";
import type { ContentBlock } from "./content-block.js";
import {
  DoorSession,
  emptyExprDoor,
  scopeConfusionDoor,
  signatureEchoFor,
  unboundInExprDoor,
  type DoorCode,
} from "./doors.js";
import { FutilityTracker, type FutilityState } from "./futility.js";
import { observationCaps, renderObservation } from "./render-observation.js";
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

/** `exec`'s `env` option is typed against arrival's concrete (intentionally UNEXPORTED)
 *  `Environment` class; `SchemeEnv` is the public structural contract `Environment` implements.
 *  Every `SchemeEnv` this module receives IS a full `Environment` at runtime — this package just
 *  can't name that type from outside arrival's package boundary (ported verbatim from
 *  manifold-tool.ts). */
type ExecEnv = NonNullable<Parameters<typeof exec>[1]>["env"];

/** Extra wall-clock grace the OUTER race allows past the in-band `budgetMs` deadline — see
 *  `run()` below: the outer race exists only for evals PARKED inside a host await (a stuck
 *  upstream tool), where arrival's trampoline can't reach its own budget check. Ported verbatim
 *  from manifold-tool.ts's `PARKED_GRACE_MS`. */
const PARKED_GRACE_MS = 250;

const UNBOUND_VARIABLE = /Unbound variable [`']?([^`'\s]+)/;

const timeoutMessage = (timeoutMs: number): string =>
  `evaluation timed out after ${timeoutMs}ms — the expr did not finish within the evaluation budget. ` +
  `Likely an infinite loop/recursion, or a stuck tool call. The environment is still usable: ` +
  `fix the runaway expression and try again, splitting the work into smaller exprs if needed.`;

// ─── REPL statement splitting (ported verbatim from manifold-tool.ts, itself ported from
// arrival-mcp's DiscoveryTool) ───
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

/** THE SCOPE-CONFUSION CASCADE DETECTION SITE — ported verbatim from manifold-tool.ts. */
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

/** THE SCOPE-CONFUSION LIBRARY-SYMBOL EXCLUSION — ported verbatim from manifold-tool.ts. */
function isLibraryEnriched(raw: string, name: string): boolean {
  const bareWall = `Unbound variable \`${name}'`;
  return raw.startsWith(bareWall) && raw.length > bareWall.length;
}

export interface RunInput {
  expr: string;
  env: SchemeEnv;
  tools: ReadonlyMap<string, BoundTool>;
  /** Per-call override, already clamped to [calibration.responseSizeMinChars,
   *  calibration.responseSizeMaxChars] by the caller. */
  responseSizeMaxChars?: number;
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
  /** Observation rendering: "braces" (default) prints dict/list results as `{:k v ...}` /
   *  `[a b ...]`; "sexpr" is the constructor-call escape hatch `(dict :k v ...)` / `(list a b
   *  ...)`. See this file's header for why this field is a necessary, additive extension of the
   *  Phase-0 frozen interface. */
  rendering?: "braces" | "sexpr";
  /** TYPE HINTS (docs/working-proposals/manifold-type-hints.md): the type-layer as an
   *  error-reporting surface, gated + wired exactly as `ManifoldToolOptions.typeHints` was.
   *  Absent ⇒ the feature is entirely inert. See this file's header for why this field is a
   *  necessary, additive extension of the Phase-0 frozen interface. */
  typeHints?: { mode: TypeHintsMode; lens: TypeHintLens };
  /** The caller's door session (verbosity gate + follow telemetry) — inject to SURVIVE a world
   *  rebuild that reconstructs the `DoorsRunner` itself (mirrors server.ts's one-per-process
   *  `DoorSession`). Absent ⇒ a private one is created (matches `ManifoldToolOptions.session`).
   *  See this file's header for why this field is a necessary, additive extension. */
  session?: DoorSession;
  /** The caller's futility tracker — same survive-a-rebuild rationale as `session` above.
   *  Absent ⇒ futility detection is off (matches the original tool option's absence behavior)
   *  — NOT defaulted to a private instance, since an un-injected tracker is indistinguishable
   *  from "this deployment doesn't want futility doors" versus "this deployment forgot to
   *  thread its process-lifetime tracker", and the original made the same choice (no
   *  fallback instance when the option was omitted). */
  tracker?: FutilityTracker;
}

/** The FULL teaching-state bundle {@link DoorsRunner.exportSession} serializes — history,
 *  competence window, futility rings, DoorSession dedup, context-ring, local-binding tracker, all
 *  plain data (V's 2026-07-05 "map but async" decision, docs/working-proposals/
 *  arrival-manifold-package-split-2026-07-05.md). `cache` is reserved for the Phase-4 replay-cache
 *  fix (a tool-valued define's wire-safe VALUE, so a restore doesn't drop it) — deliberately NOT
 *  populated by Phase 2 (no such mechanism exists in the ported `session-history.ts` replay yet;
 *  populating this field ahead of that fix would be indistinguishable from a real cache with none
 *  of its behavior), kept in the blob schema now so Phase 4 is a value-population change, not a
 *  schema migration. */
interface SessionBlob {
  v: 1;
  history: readonly SessionHistoryEntry[];
  cache: Record<string, string>;
  competence: CompetenceState;
  futility: FutilityState;
  localBindings: LocalBindingState;
  doorSession: { seen: readonly string[]; pendingFollow: readonly (readonly [string, DoorCode])[]; seq: number };
  contextRing: readonly (readonly [string, string])[];
}

/** Session-scoped stateful runner — NOT a pure function. Holds door session, competence window,
 *  local-binding tracker, session-history, context-ring, and call/generation counters across
 *  calls to `run()`. */
export interface DoorsRunner {
  run(input: RunInput): Promise<RunResult>;
  /** Serializes the FULL teaching-state bundle to one JSON blob (history, cache, competence
   *  window, futility rings, DoorSession dedup, context-ring) — everything `AsyncSessionStore`
   *  round-trips. */
  exportSession(): string;
  restoreSession(blob: string): void;
}

export function createDoorsRunner(options: DoorsRunnerOptions): DoorsRunner {
  const calibration: CalibrationOptions = { ...DEFAULT_CALIBRATION, ...options.calibration };
  const { toolNaming, strategies, attachmentSink } = options;

  const session = options.session ?? new DoorSession();
  const tracker = options.tracker;
  const competence = createCompetenceTracker(calibration.competenceWindowSize, calibration.competenceStableThreshold);
  const localBindingTracker = createLocalBindingTracker();
  let callCounter = 0;
  let generation = 0;

  // SESSION HISTORY + CONTEXT RING both need the bound-tool roster at CONSTRUCTION (their
  // tool-valued-define detection bakes a regex over `knownToolNames` once). The runner is
  // env/tool-lifecycle-agnostic (RunInput.tools arrives fresh per call, not at
  // createDoorsRunner time) — so both are lazily constructed from the FIRST call's roster and
  // reused thereafter, mirroring manifold-tool.ts's real usage (one DoorsRunner per world; the
  // roster is stable across every call in that world's lifetime) while degrading gracefully
  // (roster frozen to whatever the first call offered) for a caller whose roster genuinely
  // varies per call.
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
    const timeoutMs = calibration.defaultEvalTimeoutMs;

    const render = (value: unknown, maxTotalCharsOverride?: number): string => {
      const effectiveMax = maxTotalCharsOverride ?? calibration.observationMaxTotalChars;
      const remedy = { collection: competence.remedyMode("collection"), string: competence.remedyMode("string") };
      const onRemedyRendered = (cls: TriggerClass): void => competence.markRendered(cls);
      return options.rendering === "sexpr"
        ? toSExprString(value, observationCaps(effectiveMax, remedy, onRemedyRendered))
        : renderObservation(value, {
            maxTotalChars: effectiveMax,
            collectionRemedyMode: remedy.collection,
            stringRemedyMode: remedy.string,
            onRemedyRendered,
          });
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
      try {
        await parse(expr);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
      }

      const statements = splitTopLevel(expr);
      if (statements.length === 0) {
        return { content: [] };
      }

      const statementFacts = statements.map(analyzeStatement);
      localBindingTracker.record(
        statementFacts.flatMap((f) => f.localBindings),
        thisCallIndex,
      );

      const parked = new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), timeoutMs + PARKED_GRACE_MS);
      });

      const blocks: ContentBlock[] = [];
      let failures = 0;
      let callUsedCollection = false;
      let callUsedString = false;
      const erroredStatementIndexes: number[] = [];

      for (const [index, statement_] of statements.entries()) {
        const statement = statement_!;
        const remaining = deadline - Date.now();
        if (remaining <= 0) return timeoutResult();
        try {
          const running = exec(statement, {
            env: input.env as unknown as ExecEnv,
            budgetMs: remaining,
            signal: controller.signal,
          });
          const raced = await Promise.race([running, parked]);
          if (raced === "timeout") {
            const result = timeoutResult();
            running.catch(() => {});
            return result;
          }
          const facts = statementFacts[index]!;
          if (facts.usesCollectionOps) callUsedCollection = true;
          if (facts.usesStringOps) callUsedString = true;
          blocks.push(
            ...raced
              .filter((r) => r !== theVoid)
              .map((r) => ({ type: "text" as const, text: render(r, callMaxTotalChars) })),
          );
          if (facts.definedName !== undefined) {
            history.push(facts.definedName, statement);
            contextRing?.push(facts.definedName, statement);
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
              const scopeDoor = scopeConfusionDoor({
                name: attempted,
                topLevelDefineStatementNumber: topLevelDefineStatementNumber(attempted, statementFacts, index),
                firstErrorStatementNumber: Math.min(...erroredStatementIndexes) + 1,
                localBindingCallIndexes: localBindingTracker.occurrences(attempted),
                currentCallIndex: thisCallIndex,
              });
              if (scopeDoor) text += session.enrichInline(scopeDoor, attempted);
            }
          } else {
            // SIGNATURE-ECHO (doors.ts's signatureEchoFor, gated by the injected misuse-shape
            // strategy) + the EXAMPLE synthesized through the injected example-synthesis
            // strategy (the two strategies.ts seams a positional consumer overrides), never
            // the kwargs-specific defaults directly.
            const echo = signatureEchoFor(statement, raw, signatureByName, input.tools, strategies.isMisuseError);
            if (echo) {
              const example = strategies.synthesizeExample(echo.tool, toolSchemas.get(echo.tool));
              text += session.echoSignature(echo.tool, echo.signatureText, example);
            }
          }
          blocks.push({ type: "text", text });
          failures += 1;
        }
      }

      competence.recordCall(callUsedCollection, callUsedString);

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
          statements,
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

      if (failures === statements.length) return { content: blocks, isError: true };
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
      competence: competence.exportState(),
      futility: tracker?.exportState() ?? [],
      localBindings: localBindingTracker.exportState(),
      doorSession: session.exportState(),
      contextRing: contextRing?.exportEntries() ?? [],
    };
    return JSON.stringify(blob);
  }

  function restoreSession(blob: string): void {
    const parsed = JSON.parse(blob) as SessionBlob;
    ensureRosterSeeded([]);
    sessionHistory!.restoreEntries(parsed.history);
    competence.importState(parsed.competence);
    tracker?.importState(parsed.futility);
    localBindingTracker.importState(parsed.localBindings);
    session.importState(parsed.doorSession);
    contextRing?.restoreEntries(parsed.contextRing);
  }

  return { run, exportSession, restoreSession };
}
