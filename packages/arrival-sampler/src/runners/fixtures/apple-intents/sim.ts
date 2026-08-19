// sim.ts — the SIMULATED device. Every tool in the registry becomes a recording rosetta binding on a
// test-local EnvCapability; calling it RECORDS `{ tool, args }` into a trace and returns a plausible
// value, never doing anything real. Stage C: the grant surface is the capability itself
// (`exec({ capabilities, scope })` auto-folds BASE_ROSTER for pure-scheme primitives like
// `(* 10 60)`), and the Σ surface is a flat grant built from the capability's baked symbols
// (`oracleEnvFromBindings` — same idiom as runners/server/tool-env.ts).

import {
  EnvCapability,
  LexicalScope,
  type SessionScope,
  type SymbolDeclaration,
} from "@inhuman.tools/arrival";
import { oracleEnvFromBindings, type OracleEnvΣ } from "@inhuman.tools/arrival/oracle";

import { APPLE_INTENTS } from "./registry.js";

/** One recorded tool call. `args` is the JS-native list the rosetta impl received —
 *  `inputRest` peels, so numbers are numbers and strings are strings. */
export interface TraceEntry {
  readonly tool: string;
  readonly args: readonly unknown[];
}

export type Trace = TraceEntry[];

/** The simulated device's contact list. The model can only address a real one (Σ-over-data via the
 *  bound `contacts` symbol + the recorded arg). */
export const CONTACTS = ["Mom", "Dad", "Alice", "Bob", "Carol", "Dr Lee"] as const;

/** Installed apps the model may `open-app`. */
export const INSTALLED_APPS = ["Calendar", "Maps", "Notes", "Music", "Camera", "Wallet", "Mail"] as const;

/** A couple of pre-seeded reminders so `complete-reminder` / `list-reminders` have something to act on. */
export const SEED_REMINDERS = ["call the plumber", "buy stamps"] as const;

/** A few seeded list names + a shopping list with items, so `add-to-list` has a real target. */
const SEED_LISTS: Record<string, string[]> = {
  Shopping: ["eggs", "bread"],
  Groceries: ["apples"],
};

export interface DeviceSim {
  /** Capability pack(s) for `exec({ capabilities })` — tools + device-state symbols. BASE_ROSTER
   *  is folded in automatically by exec for pure-scheme primitives. */
  readonly capabilities: readonly EnvCapability[];
  /** Lexical frame for REPL-style define accumulation (`exec({ scope })`). */
  readonly scope: SessionScope;
  /** Pre-built Σ grant — `makeOracle(grant)` admits exactly the device + common base names. */
  readonly grant: OracleEnvΣ;
  /** The recorded trace — read after `exec` to score the materialization. */
  readonly trace: Trace;
  /** Reset the trace between cells (the scope is reusable; the trace is per-run). */
  reset(): void;
}

/** A plausible return value per domain, so a program that uses the result still runs. Kept trivial —
 *  scoring reads the TRACE, not the return. */
export function plausibleReturn(name: string): unknown {
  if (name === "list-reminders") return [...SEED_REMINDERS];
  if (name === "show-list") return [...SEED_LISTS.Shopping];
  if (name === "weather-now") return "72°F and sunny";
  if (name === "show-balance") return 42.5;
  return "ok";
}

/** Inert callables for common pure-scheme heads the constrained sampler may emit in slot
 *  expressions (`(* 10 60)`, `(list …)`). Σ only needs the NAME + callability bit; execution
 *  resolves the real base-roster procedures through `exec({ capabilities })`. */
const inert = (): unknown => null;
const BASE_GRANT_OPS: Record<string, () => unknown> = {
  list: inert,
  "*": inert,
  "+": inert,
  "-": inert,
  "/": inert,
};

/**
 * Build the Σ grant from a capability's baked symbols (plus common base heads). The same shape
 * `runners/server/tool-env.ts` uses — fn value ⇒ callable operator, non-fn ⇒ nameable value.
 */
export function grantFromCapability(cap: EnvCapability): OracleEnvΣ {
  const symbols = (cap.spec.symbols ?? {}) as Record<string, unknown>;
  return oracleEnvFromBindings({ ...BASE_GRANT_OPS, ...symbols });
}

/**
 * Build a fresh simulated device: an EnvCapability with every registry tool as a recording
 * rosetta, plus the device-state symbols (`contacts`, `apps`, `reminders`). Returns capabilities
 * (for exec), a fresh lexical scope, the pre-built Σ grant, and the live trace.
 */
export async function makeDeviceSim(): Promise<DeviceSim> {
  const trace: Trace = [];
  const scope = LexicalScope.fresh("apple-device-grant");

  // Test-local EnvCapability (`symbol.rosetta` verbs), one verb per tool.
  // Fixed head is empty; rest is a peeling union so decode deep-lenses. The impl
  // is JS-land and just records. Output stays `z.dynamic` (raw JS return).
  const cap = EnvCapability.define("apple-device-sim", {
    symbols: (symbol, z) => {
      const symbols: Record<string, SymbolDeclaration> = {};
      for (const tool of APPLE_INTENTS) {
        symbols[tool.name] = symbol.rosetta`${tool.name}: recording device stub`(
          {
            input: [],
            inputRest: z.union([z.number, z.boolean, z.list(z.string), z.string]),
            output: [z.dynamic],
          },
          (...args: unknown[]): unknown => {
            trace.push({ tool: tool.name, args });
            return plausibleReturn(tool.name);
          },
        );
      }
      // Device-state symbols — REAL own bindings (so Σ's oracle scan admits naming them).
      // `symbol.value` boxes via fromJS at define time — plain JS arrays, no CONSTANT_CTX.
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
