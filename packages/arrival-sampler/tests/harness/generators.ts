// generators.ts — the test/eval model backends behind the `SchemeGenerator` contract.
//
//   • mockGenerator(canned)  — a stub returning canned scheme keyed by task id. Proves the WHOLE pipeline
//                              (prompt → generate → eager-run → score → table) with NO download. CI-safe.
//   • buildSystemPrompt()    — the apple-intents system / few-shot framing the materialize eval defaults to.
//
// The REAL model backend is the gguf llama.cpp/Metal generator (`llamaCppGenerator`, decode/llama-cpp-generate.ts);
// these stay under __harness__ (not the shipping tree). The `SchemeGenerator`/`GenerateOptions` contract +
// the prompt framing + `extractSchemeForm` stay in runner/generate.ts (the node decode path imports those).

import dedent from "dedent";

import { APPLE_INTENTS, type ToolSpec } from "../../src/runners/fixtures/apple-intents/registry.js";
import { CONTACTS, INSTALLED_APPS } from "../../src/runners/fixtures/apple-intents/sim.js";
import { type SchemeGenerator } from "../../src/runners/generate.js";

// ── The apple-intents system / few-shot framing — the materialize eval's DEFAULT prompt ──────────────
// Lives here (not in the shipping runner/generate) so the `./server` build stays fixture-free; the
// shipping path's caller supplies its own system prompt.

function toolLine(t: ToolSpec): string {
  const params = t.params
    .map((pp) => (pp.values ? `${pp.name}:${pp.values.join("|")}` : `${pp.name}:${pp.type}`))
    .join(" ");
  const sig = params ? `${t.name} ${params}` : t.name;
  return `(${sig}) — ${t.doc}`;
}

/** The apple-intents system prompt (tools + contacts + few-shot) the materialize eval defaults to. */
export function buildSystemPrompt(): string {
  const tools = APPLE_INTENTS.map(toolLine).join("\n");
  return dedent`
    You control a phone by emitting ONE Scheme program.
    Call ONLY the tools listed below, by their exact names. The LAST form is the action to take.
    Arguments are positional and typed: strings in double-quotes, numbers bare, booleans #t/#f.
    You may use arithmetic (+ - * /) to compute numeric arguments (e.g. minutes to seconds).
    Known contacts: ${CONTACTS.join(", ")}. Installed apps: ${INSTALLED_APPS.join(", ")}.

    TOOLS:
    ${tools}

    EXAMPLES:
    User: Set a timer for 5 minutes.
    Program: (set-timer (* 5 60))
    User: Text Alice I am on my way.
    Program: (send-message "Alice" "I am on my way")
    User: Turn off the flashlight.
    Program: (set-flashlight #f)`;
}

// ── Mock backend ─────────────────────────────────────────────────────────────────────────────────

/**
 * A canned generator. `canned` maps a task prompt (or a substring of it) to the scheme the "model"
 * emits. Used to prove the harness. By default returns a structurally-valid program; pass a `garbage`
 * to simulate an unconstrained tiny model emitting unbound/malformed output.
 */
export function mockGenerator(opts: {
  label?: string;
  /** taskPrompt → scheme. The first key that is a substring of the prompt wins. */
  canned: Record<string, string>;
  /** What an UNCONSTRAINED mock emits (the garbage control). Defaults to an unbound-operator program. */
  garbage?: string;
}): SchemeGenerator {
  const { label = "mock", canned, garbage = '(do_the_thing "stuff")' } = opts;
  return {
    label,
    real: false,
    generate: (taskPrompt, gopts) => {
      if (!gopts.constrained) return Promise.resolve(garbage);
      const hit = Object.entries(canned).find(([k]) => taskPrompt.toLowerCase().includes(k.toLowerCase()));
      return Promise.resolve(hit ? hit[1] : '(web-search "unknown")');
    },
  };
}
