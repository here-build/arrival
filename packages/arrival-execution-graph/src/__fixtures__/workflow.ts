/**
 * A story-only stand-in for an agent harness's scheme verbs: spawned agents (`agent/ask`,
 * `agent/call`), standing bots (`bot/ask`, `bot/call`), elicitation (`user/ask`), MCP tools
 * (`mcp/tool` over Gmail / GitHub / Slack tool names), the `meta-reactivity/added|removed` list
 * diff and `self/notify`. The contracts (arity, keyword tails, void results, declared provenance
 * roles) mirror a real harness; the answers are deterministic mock data. Every call parks in the
 * run's `Gate`, so actual mode animates and parallel tracks finish out of order.
 *
 * A world is stateful across "Run again": the inbox grows by one thread per run, a bot remembers
 * how many turns it has taken, and `meta-reactivity/*` keeps the previous input per access, so the
 * second run's diff is smaller than the first.
 */
import { EnvCapability, isSchemeValue, jsToScheme, type SchemeValue, toJS } from "@here.build/arrival";
import { APair, nil } from "@here.build/arrival/reflect-internals";

import type { CapabilityPack } from "./live.js";
import type { Gate } from "../__tests__/program-harness.js";

export const WORKFLOW_SYMBOLS = [
  "agent/ask",
  "agent/call",
  "bot/ask",
  "bot/call",
  "user/ask",
  "mcp/tool",
  "meta-reactivity/added",
  "meta-reactivity/removed",
  "self/notify",
];

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
type Row = Record<string, Json>;

const js = (v: unknown): unknown => (isSchemeValue(v) ? toJS(v as SchemeValue) : v);
const str = (v: unknown): string => String(js(v) ?? "");

/** A keyword tail (`:query "is:unread" :max_results 10`) as a record. */
function kwargs(rest: readonly unknown[]): Row {
  const out: Row = {};
  for (let at = 0; at + 1 < rest.length; at += 2) out[str(rest[at]).replace(/^:/, "")] = js(rest[at + 1]) as Json;
  return out;
}

// ── mock corpus ───────────────────────────────────────────────────────────────────────────────

const THREADS: Row[] = [
  {
    id: "18f2a01",
    sender: "billing@northwind.io",
    subject: "Re: invoice #4471 is 30 days overdue",
    label_ids: ["INBOX"],
  },
  {
    id: "18f2a02",
    sender: "ops@meridian-health.com",
    subject: "Checkout returns 500 since the 2.14 deploy",
    label_ids: ["INBOX", "IMPORTANT"],
  },
  { id: "18f2a03", sender: "priya@lumen.studio", subject: "Can we get SSO on the Team plan?", label_ids: ["INBOX"] },
  {
    id: "18f2a04",
    sender: "noreply@vercel.com",
    subject: "Your weekly usage report",
    label_ids: ["INBOX", "CATEGORY_UPDATES"],
  },
  {
    id: "18f2a05",
    sender: "qa@brightpath.edu",
    subject: "Export to PDF crashes on Safari 18",
    label_ids: ["INBOX", "IMPORTANT"],
  },
  {
    id: "18f2a06",
    sender: "sam@linear.app",
    subject: "Partnership intro — shared roadmap sync?",
    label_ids: ["INBOX"],
  },
  {
    id: "18f2a07",
    sender: "security@npmjs.com",
    subject: "Advisory: prototype pollution in a direct dependency",
    label_ids: ["INBOX", "IMPORTANT"],
  },
  {
    id: "18f2a08",
    sender: "events@acme.com",
    subject: "Offsite agenda — draft v2",
    label_ids: ["INBOX", "CATEGORY_UPDATES"],
  },
];

const PULLS: Row[] = [
  {
    number: 412,
    title: "Split the checkout API seam behind a flag",
    user: "mkim",
    draft: false,
    head: "checkout-seam",
  },
  { number: 415, title: "WIP: experiment with streaming SSR", user: "jlee", draft: true, head: "ssr-stream" },
  {
    number: 417,
    title: "Bump undici to 6.21.1 (security)",
    user: "dependabot[bot]",
    draft: false,
    head: "deps/undici",
  },
  { number: 418, title: "Export: render PDFs off the main thread", user: "apark", draft: false, head: "pdf-worker" },
];

const FILES: Record<number, Row[]> = {
  412: [
    { filename: "src/api/checkout.ts", additions: 184, deletions: 61 },
    { filename: "src/api/flags.ts", additions: 12, deletions: 0 },
  ],
  417: [{ filename: "pnpm-lock.yaml", additions: 9, deletions: 9 }],
  418: [
    { filename: "src/export/pdf.worker.ts", additions: 220, deletions: 0 },
    { filename: "src/export/pdf.ts", additions: 18, deletions: 140 },
  ],
};

const ALERTS: Row[] = [
  { ts: "1729412001.000100", user: "PagerDuty", text: "[FIRING] checkout-api p99 latency 2.4s > 800ms (us-east-1)" },
  { ts: "1729412044.000200", user: "Datadog", text: "[FIRING] checkout-api 5xx rate 7.2% > 1%" },
  { ts: "1729412090.000300", user: "dana", text: "seeing timeouts from payments-gateway too, anyone on it?" },
];

const ANNOUNCEMENTS: Row[] = [
  { ts: "1729300000.000100", user: "maya", text: "Billing v2 is live for all new workspaces" },
  { ts: "1729310000.000200", user: "leo", text: "Design review moves to Thursdays from next week" },
];

const CI_TESTS = [
  "checkout.e2e › applies coupon",
  "export.spec › paginates long tables",
  "auth.spec › refreshes runKey",
  "search.spec › debounces input",
];

const ISSUES: Row[] = [
  { number: 301, title: "Dark mode flicker on first paint", state: "open" },
  { number: 304, title: "Coupon field accepts negative values", state: "open" },
  { number: 309, title: "Rate-limit the export endpoint", state: "open" },
  { number: 311, title: "Docs: SSO setup guide is stale", state: "open" },
];

function triage(subject: string): Row {
  const s = subject.toLowerCase();
  if (/500|crash|advisory|pollution|error/.test(s))
    return {
      category: "bug",
      urgency: s.includes("advisory") || s.includes("500") ? "high" : "normal",
      summary: subject,
    };
  if (/\?|intro|sso/.test(s)) return { category: "question", urgency: "normal", summary: subject };
  if (/invoice|overdue/.test(s)) return { category: "billing", urgency: "high", summary: subject };
  return { category: "fyi", urgency: "low", summary: subject };
}

// ── a world ───────────────────────────────────────────────────────────────────────────────────

/** One story's mock world. `capability(gate)` is called once per run; `run` counts the runs that
 *  reached a host call, so data that evolves across "Run again" (the inbox, the diff baselines,
 *  the bots' memory) does not advance on a run cancelled before it started. */
class World {
  /** Runs that made at least one host call. */
  private runs = 0;
  private current: object | undefined;
  /** meta-reactivity: committed snapshot per access, and this run's staged one. */
  private readonly committed = new Map<string, unknown[]>();
  private staged = new Map<string, unknown[]>();
  private readonly botTurns = new Map<string, number>();
  private asks = new Map<string, number>();

  constructor(seed: Record<string, unknown[]>) {
    for (const [k, v] of Object.entries(seed)) this.committed.set(k, v);
  }

  /** The run index (0-based) of the run that owns `runKey`; the first call of a run opens it. */
  private enter(runKey: object): number {
    if (this.current !== runKey) {
      if (this.current !== undefined) this.runs += 1;
      this.current = runKey;
      for (const [k, v] of this.staged) this.committed.set(k, v);
      this.staged = new Map();
      this.asks = new Map();
    }
    return this.runs;
  }

  capability(gate: Gate): EnvCapability {
    const runKey = {};
    const park = async <T>(label: string, answer: (run: number) => T): Promise<T> => {
      const run = this.enter(runKey);
      await gate.call(label);
      return answer(run);
    };
    // eslint-disable-next-line @typescript-eslint/no-this-alias, unicorn/no-this-assignment
    const world = this;

    const diff = (which: "added" | "removed") =>
      async function (this: { runCtx: unknown }, ...args: unknown[]) {
        world.enter(runKey);
        let identity: string | undefined;
        let list: unknown;
        for (let at = 0; at < args.length; at++) {
          const head = str(args[at]);
          if (head === ":identity") identity = str(args[++at]).replace(/^:/, "");
          else list = args[at];
        }
        const items = (js(list) as unknown[] | null) ?? [];
        const key = identity ?? "position";
        const prev = world.committed.get(key);
        world.staged.set(key, items);
        await gate.call(`meta-reactivity/${which}`);
        const id = (x: unknown, i: number) => (identity ? JSON.stringify((x as Row)[identity]) : String(i));
        const ids = (xs: unknown[]) => new Set(xs.map(id));
        // First access (no baseline) is an empty delta: establishing the baseline is not `added`.
        let out: unknown[] = [];
        if (prev !== undefined && which === "added") out = items.filter((x, i) => !ids(prev).has(id(x, i)));
        if (prev !== undefined && which === "removed") out = prev.filter((x, i) => !ids(items).has(id(x, i)));
        // A proper list, as the real operator returns (`APair.fromArray`), not a borrowed JS array.
        const runCtx = (this as any).runCtx;
        return out.length === 0
          ? nil
          : APair.fromArray(
              runCtx,
              out.map((x) => jsToScheme(runCtx, x)),
              false,
            );
      };

    const agent = (verb: string) =>
      function (spec: unknown, message: string) {
        const who = str(spec);
        return park(`${verb} ${who}`, () => agentAnswer(verb, who, message));
      };

    return EnvCapability.define("execution-graph-story/workflow", {
      symbols: (symbol: any, sz: any) => ({
        "agent/ask": symbol.rosetta`agent/ask: create a disposable worker and wait for its required response`(
          { input: [sz.dynamic, sz.string], inputRest: sz.dynamic, output: [sz.dynamic], provenance: "source" },
          agent("agent/ask"),
        ),
        "agent/call":
          symbol.rosetta`agent/call: create a disposable worker and wait for it to finish, with or without a response`(
            { input: [sz.dynamic, sz.string], inputRest: sz.dynamic, output: [sz.string], provenance: "source" },
            agent("agent/call"),
          ),
        "bot/ask":
          symbol.rosetta`bot/ask: wait for a standing bot's response; finishing without a response is an error`(
            { input: [sz.dynamic], inputRest: sz.dynamic, output: [sz.dynamic], provenance: "source" },
            (spec: unknown, message: unknown) => {
              const bot = str(spec);
              const turn = (this.botTurns.get(bot) ?? 0) + 1;
              this.botTurns.set(bot, turn);
              return park(`bot/ask ${bot}`, () => botAnswer(bot, str(message), turn));
            },
          ),
        "bot/call": symbol.rosetta`bot/call: wait for a standing bot to respond or finish without a response`(
          { input: [sz.foldName, sz.string], output: [sz.string], provenance: "source" },
          (bot: string, message: string) => {
            const turn = (this.botTurns.get(bot) ?? 0) + 1;
            this.botTurns.set(bot, turn);
            return park(`bot/call ${bot}`, () => (/ship|go|ack/i.test(message) ? "" : botAnswer(bot, message, turn)));
          },
        ),
        "user/ask": symbol.rosetta`user/ask: ask the user and wait for the answer`(
          { input: [sz.string], inputRest: sz.dynamic, output: [sz.dynamic], provenance: "source" },
          (question: string) => {
            // Re-asks count per topic, not per wording: "…is not a work email. What's your work email?"
            this.enter(runKey);
            const topic = topicOf(question);
            const nth = (this.asks.get(topic) ?? 0) + 1;
            this.asks.set(topic, nth);
            return park(`user/ask ${topic}`, () => userAnswer(topic, question, nth));
          },
        ),
        "mcp/tool": symbol.rosetta`mcp/tool: invoke a live MCP tool; connection and tool are data`(
          { input: [sz.foldName, sz.foldName], inputRest: sz.dynamic, output: [sz.dynamic], provenance: "source" },
          (server: string, tool: string, ...rest: unknown[]) => {
            const args = kwargs(rest);
            return park(`${server}.${tool}`, (run) => mcpAnswer(server, tool, args, run));
          },
        ),
        "meta-reactivity/added": symbol.native`meta-reactivity/added: items whose identity is new at this access`(
          { input: [], inputRest: sz.schemeValue, output: [sz.schemeValue], provenance: "pipe" },
          diff("added"),
        ),
        "meta-reactivity/removed": symbol.native`meta-reactivity/removed: items whose identity left this access`(
          { input: [], inputRest: sz.schemeValue, output: [sz.schemeValue], provenance: "pipe" },
          diff("removed"),
        ),
        "self/notify":
          symbol.rosetta`self/notify: send an update from this program or worker request without completing it`(
            { input: [sz.string], output: [sz.undefinedResult], provenance: "source" },
            (message: string) => park(`self/notify ${message}`, () => undefined),
          ),
      }),
    });
  }
}

/** The inbox at run `run`: a five-thread window that slides one thread per run. */
const inboxAt = (run: number): Row[] => Array.from({ length: 5 }, (_, i) => THREADS[(run + i) % THREADS.length]!);

function mcpAnswer(server: string, tool: string, args: Row, run: number): unknown {
  const id = `${server}.${tool}`;
  switch (id) {
    case "gmail.search_threads": {
      return { threads: inboxAt(run), resultSizeEstimate: 5 };
    }
    case "gmail.get_thread": {
      const t = THREADS.find((x) => x.id === args.threadId) ?? THREADS[0]!;
      return {
        id: t.id,
        messages: [{ ...t, plaintext_body: `Hi team — ${String(t.subject).toLowerCase()}. Details below.` }],
      };
    }
    case "gmail.create_draft": {
      return { id: `r-58213${run}`, threadId: `18f2b${run}0`, viewUrl: "https://mail.google.com/mail/#drafts" };
    }
    case "gmail.label_thread": {
      return { id: args.thread_id, label_ids: ["INBOX", String(args.label)] };
    }
    case "github.list_pull_requests": {
      return PULLS;
    }
    case "github.get_pull_request_files": {
      return FILES[Number(args.pullNumber)] ?? [];
    }
    case "github.create_pull_request_review": {
      return {
        id: 9_000_000 + Number(args.pullNumber),
        state: args.event === "APPROVE" ? "APPROVED" : "CHANGES_REQUESTED",
      };
    }
    case "github.create_issue": {
      if (args.repo === "infra")
        throw new Error("403 Resource not accessible by integration (POST /repos/acme/infra/issues)");
      return {
        number: 320 + (String(args.title).length % 9),
        html_url: `https://github.com/acme/${String(args.repo)}/issues/321`,
      };
    }
    case "github.list_issues": {
      // One issue closes per run: `removed` sees it leave the open list.
      return ISSUES.slice(Math.min(run, ISSUES.length - 1));
    }
    case "github.list_workflow_runs": {
      return { workflow_runs: [{ id: 11_873_402, name: "ci", head_branch: "main", conclusion: "failure" }] };
    }
    case "github.list_workflow_jobs": {
      return { jobs: CI_TESTS.map((name, i) => ({ id: 3100 + i, name, conclusion: "failure" })) };
    }
    case "github.get_job_logs": {
      return { logs: `Error: Timeout 5000ms exceeded waiting for selector (job ${String(args.job_id)})` };
    }
    case "github.rerun_failed_jobs": {
      return { status: "queued" };
    }
    case "slack.slack_get_channel_history": {
      return { messages: args.channel_id === "C02ALERTS" ? ALERTS : ANNOUNCEMENTS };
    }
    case "slack.slack_post_message": {
      return { ok: true, channel: args.channel_id, ts: `17294120${run}${String(args.text).length}.000100` };
    }
    case "slack.slack_reply_to_thread": {
      return { ok: true, thread_ts: args.thread_ts };
    }
    case "slack.slack_add_reaction": {
      return { ok: true };
    }
    default: {
      throw new Error(`mcp: unknown tool ${id}`);
    }
  }
}

function agentAnswer(verb: string, who: string, message: string): unknown {
  switch (who) {
    case "triage": {
      return triage(message);
    }
    case "drafter": {
      return `Thanks for flagging this — we've opened a ticket and will follow up within one business day. (${message.slice(0, 40)}…)`;
    }
    case "security":
    case "performance":
    case "api-design": {
      const risky = /undici|checkout/.test(message);
      return {
        lens: who,
        verdict: who === "security" && risky ? "concern" : "ok",
        note: `${who}: ${risky ? "needs a look at input validation" : "nothing blocking"}`,
      };
    }
    case "lead-reviewer": {
      return /concern/.test(message) ? "request-changes" : "approve";
    }
    case "sre": {
      return {
        cause: "payments-gateway connection pool exhausted",
        severity: "sev2",
        action: "raise pool size and shed retries",
      };
    }
    case "flake-doctor": {
      return /checkout|export/.test(message) ? "flaky" : "broken";
    }
    case "editor": {
      return `Weekly digest — ${message.split("\n").length} items. Highlights: checkout seam split, PDF export off main thread.`;
    }
    case "summarizer": {
      return message.length > 60 ? `${message.slice(0, 57)}…` : message;
    }
    case "provisioner": {
      // `agent/call` may finish without a response.
      return verb === "agent/call" ? "" : "provisioned";
    }
    default: {
      return `${who}: done`;
    }
  }
}

function botAnswer(bot: string, message: string, turn: number): unknown {
  if (bot === "release-captain") {
    // Remembered across runs: by the second standup the undici bump has landed.
    if (/blocker/i.test(message)) return turn > 4 ? "none" : "PR #417 (undici bump) still waiting on CI";
    if (/changelog/i.test(message)) return "- checkout seam split\n- PDFs render off the main thread\n- undici 6.21.1";
    if (/version/i.test(message)) return "2.15.0";
    return `turn ${turn}: noted`;
  }
  if (bot === "oncall") return turn % 3 === 0 ? "resolved" : `mitigating (${message.slice(0, 32)})`;
  return `${bot} turn ${turn}`;
}

const TOPICS = ["work email", "role", "team", "start date", "reply", "ship"] as const;
const topicOf = (question: string): string => TOPICS.find((t) => question.toLowerCase().includes(t)) ?? question;

function userAnswer(topic: string, question: string, nth: number): unknown {
  switch (topic) {
    case "work email": {
      return ["dana kim", "dana@gmail.com", "dana.kim@acme.com"][Math.min(nth - 1, 2)];
    }
    case "role": {
      return "engineer";
    }
    case "team": {
      return "payments";
    }
    case "start date": {
      return "2026-11-02";
    }
    case "reply": {
      return "yes, send it";
    }
    case "ship": {
      return /blockers: none/i.test(question) ? "ship" : "wait";
    }
    default: {
      return "ok";
    }
  }
}

/** A fresh world per story: its own inbox clock, diff baselines and bot memory. The diff baseline
 *  is seeded as if an earlier tick already saw the first two threads (keyed by identity field). */
export function workflowPack(prelude = ""): CapabilityPack {
  const world = new World({
    id: THREADS.slice(0, 2),
    number: [{ number: 298, title: "Flaky login redirect on Firefox", state: "open" }, ...ISSUES],
  });
  return { prelude, symbols: WORKFLOW_SYMBOLS, capability: (gate) => world.capability(gate) };
}
