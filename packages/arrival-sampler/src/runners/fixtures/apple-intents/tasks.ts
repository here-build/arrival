// tasks.ts — a dozen typical EXPLICIT device intents. Each task is a natural-language prompt plus an
// `expect(trace)` predicate that checks the recorded trace MATERIALIZED the right tool + the right
// slots. Free-text args (a message body, a reminder text) are scored FUZZILY (keyword containment);
// structural slots (the tool name, a contact, a number) are checked exactly-ish.
//
// The predicate reads the LAST recorded entry that matches the expected tool — a model may emit a
// couple of forms; the action is the materialized tool call.

import type { Trace, TraceEntry } from "./sim.js";

export interface Task {
  readonly id: string;
  readonly prompt: string;
  /** True iff the trace materialized the intended action with acceptable slots. */
  readonly expect: (trace: Trace) => boolean;
}

/** Find the last recorded call to `tool` (the materialized action of interest). */
const last = (trace: Trace, tool: string): TraceEntry | undefined => {
  for (let i = trace.length - 1; i >= 0; i--) if (trace[i].tool === tool) return trace[i];
  return undefined;
};

/** Lowercased string of an arg (numbers/strings/contacts all coerce). */
const s = (v: unknown): string => String(v ?? "").toLowerCase();

/** Does any arg of the entry contain ALL of the given keywords (fuzzy free-text match)? */
const argsContainAll = (e: TraceEntry, ...keywords: string[]): boolean => {
  const blob = e.args.map(s).join(" ");
  return keywords.every((k) => blob.includes(k.toLowerCase()));
};

/** Does any arg contain ANY of the keywords? */
const argsContainAny = (e: TraceEntry, ...keywords: string[]): boolean => {
  const blob = e.args.map(s).join(" ");
  return keywords.some((k) => blob.includes(k.toLowerCase()));
};

/** A numeric arg equal to `n` (within tolerance), wherever it sits. */
const hasNumber = (e: TraceEntry, n: number, tol = 0.5): boolean =>
  e.args.some((a) => typeof a === "number" && Math.abs(a - n) <= tol) ||
  e.args.some((a) => Math.abs(Number(a) - n) <= tol);

export const TASKS: readonly Task[] = [
  {
    id: "timer-10min",
    prompt: "Set a timer for 10 minutes.",
    // 10 minutes = 600 seconds. Accept either the seconds form or a bare 10 (model gave minutes).
    expect: (t) => {
      const e = last(t, "set-timer");
      return !!e && (hasNumber(e, 600) || hasNumber(e, 10));
    },
  },
  {
    id: "text-mom-late",
    prompt: "Text Mom I'll be 10 minutes late.",
    expect: (t) => {
      const e = last(t, "send-message");
      return !!e && argsContainAll(e, "mom") && argsContainAny(e, "late", "10", "minute");
    },
  },
  {
    id: "remind-call-dentist",
    prompt: "Remind me to call the dentist tomorrow at 9am.",
    expect: (t) => {
      const e = last(t, "create-reminder");
      return !!e && argsContainAll(e, "dentist");
    },
  },
  {
    id: "dnd-on",
    prompt: "Turn on do not disturb.",
    expect: (t) => {
      const e = last(t, "set-do-not-disturb");
      return !!e && argsContainAny(e, "true", "#t", "on", "1");
    },
  },
  {
    id: "play-music",
    prompt: "Play some music.",
    // Either the generic play-music or play-song/play-artist counts as materializing the intent.
    expect: (t) =>
      !!(last(t, "play-music") ?? last(t, "play-song") ?? last(t, "play-artist") ?? last(t, "play-playlist")),
  },
  {
    id: "navigate-home",
    prompt: "Navigate home.",
    expect: (t) =>
      !!(last(t, "navigate-home") ?? (last(t, "navigate-to") && argsContainAny(last(t, "navigate-to")!, "home"))),
  },
  {
    id: "tip-15-on-80",
    prompt: "What's a 15% tip on 80?",
    // The materialization here is a web-search or wiki-lookup OR a translate — but the canonical
    // intent for "compute" has no device tool, so the RIGHT move is web-search the question. Accept
    // web-search containing the numbers, OR (lenient) any tool that recorded 12 (the answer) or 80.
    expect: (t) => {
      const ws = last(t, "web-search");
      if (ws && argsContainAny(ws, "tip", "15", "80")) return true;
      // Some models will (wrongly but understandably) try to materialize the math as an arg.
      return t.some((e) => hasNumber(e, 12) || (hasNumber(e, 15) && hasNumber(e, 80)));
    },
  },
  {
    id: "add-milk-shopping",
    prompt: "Add milk to my shopping list.",
    expect: (t) => {
      const e = last(t, "add-to-list");
      return !!e && argsContainAll(e, "milk") && argsContainAny(e, "shop");
    },
  },
  {
    id: "call-dad",
    prompt: "Call Dad.",
    expect: (t) => {
      const e = last(t, "call-contact") ?? last(t, "facetime-contact");
      return !!e && argsContainAll(e, "dad");
    },
  },
  {
    id: "set-alarm-7am",
    prompt: "Set an alarm for 7am.",
    expect: (t) => {
      const e = last(t, "set-alarm");
      return !!e && argsContainAny(e, "7", "07", "seven");
    },
  },
  {
    id: "flashlight-on",
    prompt: "Turn on the flashlight.",
    expect: (t) => {
      const e = last(t, "set-flashlight");
      return !!e && argsContainAny(e, "true", "#t", "on", "1");
    },
  },
  {
    id: "start-run",
    prompt: "Start a running workout.",
    expect: (t) => {
      const e = last(t, "start-workout");
      return !!e && argsContainAny(e, "run");
    },
  },
  {
    id: "send-email-bob",
    prompt: "Email Bob the meeting is moved to Friday.",
    expect: (t) => {
      const e = last(t, "send-email");
      return !!e && argsContainAll(e, "bob") && argsContainAny(e, "friday", "meeting", "moved");
    },
  },
  {
    id: "take-photo",
    prompt: "Take a photo.",
    expect: (t) => !!(last(t, "take-photo") ?? last(t, "open-camera")),
  },
];
