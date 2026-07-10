// Chibi harness v2 — runner.ts (design: docs/test-suite-v2/chibi-harness-v2.md §1, §2, §7, §9).
//
// CorpusRunner owns the SINGLE shared env (built like `freshEnv()`, `_fresh-env.ts:35-45`, with
// the v2 harness capability assembled on top via `assembleEnv` — the same path v1 uses and
// production uses) and a monotone cursor over the manifest's full step list (setups + tests +
// blocks + unreadable, in corpus order — section markers just adjust bookkeeping). `outcomeFor`
// advances the cursor to the requested step (running every pending `setup`/`block`/`test` in
// between for its side effects), executes the step itself if not already cached, and returns
// its `StepOutcome`. A block's execution is triggered by WHICHEVER of its members' `outcomeFor`
// calls reaches it first — naturally correct even when member 0 is itself `it.skip` (an
// excluded member's `it()` body never runs, so it never calls `outcomeFor`; the block still
// executes the first time a NON-skipped sibling's body does, per §4's "an it.skip row's form is
// never evaluated").
//
// Env-state strategy: (a) ordered sequential execution sharing one env (§2's chosen option) —
// no per-test isolation, no retry. A setup's failure doesn't abort the run; it's recorded
// (`lastSetupFailure`) so a later step's OWN unexplained throw can be attributed to it
// (`setup-failed`) instead of a bare, confusing "unbound variable" message.
import { freshEnv } from "../_fresh-env.js";
import type { ResolvingEnvironment } from "../../Environment.js";
import { assembleEnv } from "../../common/kernel.js";
import type { SchemeEnv } from "../../common/scheme-env.js";
import { exec } from "../../eval/generator-exec.js";
import { ArrivalError } from "../../errors.js";
import { createChibiHarnessV2, type OutcomeSink, type StepOutcome } from "./harness-capability.js";
import type { Manifest, Step, TestStep } from "./manifest.js";

/** Wall-clock budget per top-level `exec` call (one form, or one block form) — see design §1
 *  "Per-step budget". A wedge becomes a red `budget` row instead of a hung run. */
export const STEP_BUDGET_MS = 5000;

type BlockStep = Extract<Step, { kind: "block" }>;
type SetupStep = Extract<Step, { kind: "setup" }>;

export class CorpusRunner {
  private cursorPos = 0;
  private readonly steps: readonly Step[];
  private readonly positionByStepIndex = new Map<number, number>();
  private readonly blockIndexByMemberIndex = new Map<number, number>();
  private readonly settled = new Map<number, StepOutcome>();
  private readonly blockOutcomes = new Map<number, StepOutcome[]>();

  // Live forensic context (§7) — valid at the moment the most recently processed step ran;
  // an `it()` body reads it immediately after `outcomeFor` resolves, before any later test's
  // `outcomeFor` can advance it further (strict corpus-order execution, §2).
  private sectionPath: string[] = [];
  private setupsInSection = 0;
  private lastSetup: { text: string; line: number } | undefined;
  private lastSetupFailure: { line: number; message: string } | undefined;

  private constructor(
    private readonly env: ResolvingEnvironment,
    private readonly sink: OutcomeSink,
    private readonly manifest: Manifest,
  ) {
    this.steps = manifest.steps;
    this.steps.forEach((step, pos) => {
      if (step.kind === "section-begin" || step.kind === "section-end") return;
      this.positionByStepIndex.set(step.index, pos);
      if (step.kind === "block") {
        for (const member of step.members) this.blockIndexByMemberIndex.set(member.index, step.index);
      }
    });
  }

  static async create(manifest: Manifest): Promise<CorpusRunner> {
    const env = await freshEnv();
    const { capability, sink } = createChibiHarnessV2();
    const evalScheme = (e: unknown, src: unknown): unknown =>
      exec(src as string, { env: e as ResolvingEnvironment, skipBootstrapWait: true });
    await assembleEnv(env as unknown as SchemeEnv, [capability.lower({ evalScheme })]);
    return new CorpusRunner(env, sink, manifest);
  }

  /** Advance the cursor as needed and return `step`'s outcome (cached after the first call). */
  async outcomeFor(step: TestStep): Promise<StepOutcome> {
    const cached = this.settled.get(step.index);
    if (cached) return cached;

    const ownIndex = this.blockIndexByMemberIndex.get(step.index) ?? step.index;
    const pos = this.positionByStepIndex.get(ownIndex);
    if (pos === undefined) {
      throw new Error(`chibi harness v2: step index ${step.index} is not present in the manifest's step list`);
    }
    if (pos < this.cursorPos) {
      // Already advanced past this step's position without settling it — a genuine ordering
      // violation (see the design doc §1's "it.each would reorder registration" note); this
      // guard is what makes that hazard loud instead of a silently-wrong outcome.
      throw new Error(
        `corpus steps executed out of order — check vitest sequence config (step ${step.index} at position ${pos}, cursor already past it at ${this.cursorPos})`,
      );
    }

    await this.advanceTo(pos);
    const outcome = this.settled.get(step.index);
    if (!outcome) {
      throw new Error(`chibi harness v2: no outcome produced for step ${step.index} after advancing the cursor`);
    }
    return outcome;
  }

  /** §7 failure forensics: exact source form + corpus file:line + reprs/error + section
   *  context (step count, setups executed in this section, and the last one's text). */
  failureError(step: TestStep, outcome: StepOutcome): Error {
    const total = this.manifest.tests.length;
    const lines = [`[${step.section}] ${step.text}  ${this.manifest.corpusPath}:${step.line}`];
    if (outcome.kind === "fail") {
      lines.push(`  expected: ${outcome.expectedRepr}`);
      lines.push(`  actual:   ${outcome.actualRepr}`);
    } else if (outcome.kind === "error") {
      const atLine = outcome.atLine !== undefined ? ` @ ${this.manifest.corpusPath}:${outcome.atLine}` : "";
      lines.push(`  error (${outcome.phase}): ${outcome.message}${atLine}`);
    }
    const setupNote =
      this.lastSetup === undefined
        ? "no setup forms executed in this section"
        : `last: ${this.lastSetup.text} @ ${this.manifest.corpusPath}:${this.lastSetup.line}`;
    lines.push(
      `  section context: ${step.section} (step ${step.index + 1}/${total}); ${this.setupsInSection} setup form(s) executed in this section, ${setupNote}`,
    );
    return new Error(lines.join("\n"));
  }

  private async advanceTo(targetPos: number): Promise<void> {
    while (this.cursorPos <= targetPos) {
      await this.processStep(this.steps[this.cursorPos]);
      this.cursorPos++;
    }
  }

  private async processStep(step: Step): Promise<void> {
    switch (step.kind) {
      case "section-begin":
        this.sectionPath.push(step.name);
        this.setupsInSection = 0;
        return;
      case "section-end":
        this.sectionPath.pop();
        return;
      case "setup":
        return this.execSetup(step);
      case "test":
        return this.execStandaloneTest(step);
      case "block":
        return this.execBlock(step);
      case "unreadable":
        return; // a reader door — never executed, per design §6
    }
  }

  private async execSetup(step: SetupStep): Promise<void> {
    try {
      await exec(step.text, { env: this.env, budgetMs: STEP_BUDGET_MS });
      this.lastSetupFailure = undefined;
    } catch (e) {
      this.lastSetupFailure = { line: step.line, message: describeError(e) };
    }
    this.lastSetup = { text: step.text, line: step.line };
    this.setupsInSection++;
  }

  private async execStandaloneTest(step: TestStep): Promise<void> {
    try {
      await exec(step.text, { env: this.env, budgetMs: STEP_BUDGET_MS });
    } catch (e) {
      this.settled.set(step.index, this.classifyFormLevelThrow(e));
      return;
    }
    const drained = this.sink.drain();
    const outcome: StepOutcome = drained[0] ?? {
      kind: "error",
      phase: "actual-eval",
      message: "js-run-test never fired for this step (the form did not dispatch through the harness hook)",
    };
    this.settled.set(step.index, outcome);
  }

  private async execBlock(step: BlockStep): Promise<void> {
    let abortedMessage: string | undefined;
    try {
      await exec(step.text, { env: this.env, budgetMs: STEP_BUDGET_MS });
    } catch (e) {
      abortedMessage = describeError(e);
    }
    const drained = this.sink.drain();
    const outcomes: StepOutcome[] = step.members.map(
      (_member, i): StepOutcome =>
        drained[i] ?? {
          kind: "error",
          phase: "block-aborted",
          message:
            abortedMessage ??
            `block produced only ${drained.length} outcome(s) for ${step.members.length} member(s) — a member past this point never ran`,
        },
    );
    this.blockOutcomes.set(step.index, outcomes);
    step.members.forEach((member, i) => this.settled.set(member.index, outcomes[i]));
  }

  private classifyFormLevelThrow(e: unknown): StepOutcome {
    const message = describeError(e);
    if (e instanceof ArrivalError && /budget/i.test(message)) return { kind: "error", phase: "budget", message };
    if (this.lastSetupFailure) {
      return { kind: "error", phase: "setup-failed", message, atLine: this.lastSetupFailure.line };
    }
    return { kind: "error", phase: "actual-eval", message };
  }
}

function describeError(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
