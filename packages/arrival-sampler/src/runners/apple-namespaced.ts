// apple-namespaced.ts — the apple-intents surface under various NAMESPACING schemes, to test whether
// (and how) namespacing changes how Rnj materializes. V's thesis: namespacing replaces one high-branching
// pick (1-of-N) with a chain of low-branching picks, and the ORDER / framing of those picks matters.
//
// Schemes (all reuse the apple TASKS + params; only the tool NAMES change, so any metric delta is naming).
// The verb splits into intent (`send`) + entity (`message`); schemes recombine it under a top grouping:
//   • "dei"  — domain/entity/intent      → `messaging/message/send`        (entity-first within domain)
//   • "die"  — domain/intent/entity      → `messaging/send/message`        (intent-first within domain)
//   • "eq"   — effect|query/entity/intent→ `effect/message/send` / `query/messages/read`  (kind replaces domain)
//   • "bang" — !effect|!query/entity/int → `!effect/message/send`          (scheme `!`=mutation cue)
//   • "env"  — env/effect|query/ent/int  → `env/effect/message/send`       ("working with a setup" framing)
// The eq/bang/env schemes keep the dei entity/intent split but swap the domain for an EASY top-level binary
// ("am I reading or mutating?"), grounded straight from the request — V's cognitive-load idea.
//
// Stage C: grant surface is EnvCapability + pre-built Σ grant (no assembleAmbient / cap.lower).

import {
  EnvCapability,
  LexicalScope,
  type SessionScope,
  type SymbolDeclaration,
} from "@inhuman.tools/arrival";
import type { OracleEnvΣ } from "@inhuman.tools/arrival/oracle";

import { APPLE_INTENTS, type ToolSpec } from "./fixtures/apple-intents/registry.js";
import {
  CONTACTS,
  type DeviceSim,
  grantFromCapability,
  INSTALLED_APPS,
  plausibleReturn,
  SEED_REMINDERS,
  type Trace,
} from "./fixtures/apple-intents/sim.js";

export type Scheme = "dei" | "die" | "eq" | "bang" | "env" | "bdei" | "bdie";

/** Read-vs-mutate classification — query tools READ state, effect tools CHANGE it. Heuristic on the verb. */
const QUERY_RE = /^(?:read|list|show|get|find|search|check|weather|view|count|recent|latest|what|when)/;
function isQuery(tool: ToolSpec): boolean {
  return QUERY_RE.test(tool.name);
}

/** Split a verb into intent (before the first `-`) + entity (after). Single-token verbs have no entity. */
function splitVerb(tool: ToolSpec): { intent: string; entity: string | null } {
  const dash = tool.name.indexOf("-");
  if (dash === -1) return { intent: tool.name, entity: null };
  return { intent: tool.name.slice(0, dash), entity: tool.name.slice(dash + 1) };
}

/** Recombine the verb under a top grouping `top` in dei (entity/intent) or die (intent/entity) order. */
function combine(top: string, tool: ToolSpec, order: "dei" | "die"): string {
  const { intent, entity } = splitVerb(tool);
  if (entity === null) return `${top}/${intent}`;
  return order === "dei" ? `${top}/${entity}/${intent}` : `${top}/${intent}/${entity}`;
}

/** The tool's name under a given scheme. eq/bang/env keep the dei (entity/intent) split, swapping the
 *  domain for the effect|query KIND (`effect/message/send`), optionally with a `!` cue or an `env/` head. */
export function appleName(tool: ToolSpec, scheme: Scheme): string {
  const domain = tool.domain.toLowerCase().replaceAll(/\s+/g, "-");
  if (scheme === "dei") return combine(domain, tool, "dei");
  if (scheme === "die") return combine(domain, tool, "die");
  const kind = isQuery(tool) ? "query" : "effect";
  if (scheme === "eq") return combine(kind, tool, "dei");
  if (scheme === "bang") return combine(`!${kind}`, tool, "dei");
  if (scheme === "env") return combine(`env/${kind}`, tool, "dei");
  // bdei/bdie: the SIGIL kind (`!effect` / `?query`) on top of the FULL domain/entity-or-intent split —
  // tests whether the confident `!`/`?` root rescues the domain-based dei/die that collapsed to `(1)`.
  const sigilKind = isQuery(tool) ? "?query" : "!effect";
  return combine(`${sigilKind}/${domain}`, tool, scheme === "bdei" ? "dei" : "die");
}

/** The namespaced tools (name + arity) for the arity table. */
export function namespacedAppleTools(scheme: Scheme): { name: string; arity: number }[] {
  return APPLE_INTENTS.map((tool) => ({ name: appleName(tool, scheme), arity: tool.params.length }));
}

/** The capabilities + scope + Σ grant a namespaced surface resolves through. */
export interface NamespacedAppleEnv {
  readonly capabilities: readonly EnvCapability[];
  readonly scope: SessionScope;
  readonly grant: OracleEnvΣ;
}

/** A grant surface binding every namespaced apple tool as a recording no-op rosetta. */
export async function makeNamespacedAppleEnv(scheme: Scheme): Promise<NamespacedAppleEnv> {
  const scope = LexicalScope.fresh(`apple-${scheme}`);
  const cap = EnvCapability.define(`apple-namespaced/${scheme}`, {
    symbols: (symbol, z) => {
      const symbols: Record<string, SymbolDeclaration> = {};
      for (const tool of APPLE_INTENTS) {
        const name = appleName(tool, scheme);
        // `: any` return — the `z.dynamic` output escape hatch skips `z.encode`, so the
        // impl's plain JS return crosses straight to `jsToScheme` (which boxes it).
        symbols[name] = symbol.rosetta`${name}: namespaced no-op recording stub`(
          { input: [], inputRest: z.dynamic, output: [z.dynamic] },
          (): any => "ok",
        );
      }
      return symbols;
    },
  });
  return { capabilities: [cap], scope, grant: grantFromCapability(cap) };
}

/**
 * A {@link DeviceSim} for a namespaced surface that BINDS each tool under its renamed name
 * (`appleName(tool, scheme)`) but RECORDS the CANONICAL `tool.name` into the trace. This is the
 * scheme-inverse done at the recording boundary: the model must emit the renamed name (Σ admits only
 * that), yet the trace speaks canonical, so the existing `task.expect` predicates + `INTENDED_TOOLS`
 * score every scheme unchanged — no per-scheme gold, no parser. Arg evaluation (`(* 10 60)` → 600)
 * happens for free because the program runs against the env (BASE_ROSTER via exec).
 */
export async function makeNamespacedDeviceSim(scheme: Scheme): Promise<DeviceSim> {
  const trace: Trace = [];
  const scope = LexicalScope.fresh(`apple-${scheme}-device-grant`);

  const cap = EnvCapability.define(`apple-namespaced-device/${scheme}`, {
    symbols: (symbol, z) => {
      const symbols: Record<string, SymbolDeclaration> = {};
      for (const tool of APPLE_INTENTS) {
        const name = appleName(tool, scheme);
        symbols[name] = symbol.rosetta`${name}: namespaced recording device stub`(
          {
            input: [],
            inputRest: z.union([z.number, z.boolean, z.list(z.string), z.string]),
            output: [z.dynamic],
          },
          (...args: unknown[]): unknown => {
            trace.push({ tool: tool.name, args }); // canonical name, not the renamed one
            return plausibleReturn(tool.name);
          },
        );
      }
      // Device-state symbols as `symbol.value` defs on the same capability — real own bindings
      // (Σ enumerability). Plain JS; symbol.value boxes via fromJS.
      symbols["contacts"] = symbol.value`contacts: seeded device contacts`([...CONTACTS]);
      symbols["apps"] = symbol.value`apps: seeded installed apps`([...INSTALLED_APPS]);
      symbols["reminders"] = symbol.value`reminders: seeded reminders`([...SEED_REMINDERS]);
      return symbols;
    },
  });

  return {
    capabilities: [cap],
    scope,
    grant: grantFromCapability(cap),
    trace,
    reset: () => {
      trace.length = 0;
    },
  };
}

function toolLine(tool: ToolSpec, scheme: Scheme): string {
  const params = tool.params
    .map((pp) => (pp.values ? `${pp.name}:${pp.values.join("|")}` : `${pp.name}:${pp.type}`))
    .join(" ");
  const name = appleName(tool, scheme);
  const sig = params ? `${name} ${params}` : name;
  return `(${sig}) — ${tool.doc}`;
}

/** The system prompt for a namespaced apple surface (namespaced names + namespaced few-shot examples). */
export function buildNamespacedApplePrompt(scheme: Scheme): string {
  const byName = (flat: string): string => {
    const tool = APPLE_INTENTS.find((tl) => tl.name === flat);
    return tool ? appleName(tool, scheme) : flat;
  };
  const tools = APPLE_INTENTS.map((tool) => toolLine(tool, scheme)).join("\n");
  return [
    "You control a phone by emitting ONE Scheme program.",
    "Call ONLY the tools listed below, by their exact `namespaced/slash/names`. The LAST form is the action.",
    "Arguments are positional and typed: strings in double-quotes, numbers bare, booleans #t/#f.",
    "You may use arithmetic (+ - * /) to compute numeric arguments (e.g. minutes to seconds).",
    `Known contacts: ${CONTACTS.join(", ")}. Installed apps: ${INSTALLED_APPS.join(", ")}.`,
    "",
    "TOOLS:",
    tools,
    "",
    "EXAMPLES:",
    `User: Set a timer for 5 minutes.\nProgram: (${byName("set-timer")} (* 5 60))`,
    `User: Text Alice I am on my way.\nProgram: (${byName("send-message")} "Alice" "I am on my way")`,
    `User: Turn off the flashlight.\nProgram: (${byName("set-flashlight")} #f)`,
  ].join("\n");
}
