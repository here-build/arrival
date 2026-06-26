// @here.build/arrival/r7rs/host — the host-interface OMISSIONS (§6.13, §6.14).
//
// Lineage: R7RS-small (Shinn, Cowan & Gleckler, eds., 2013) — §6.13 Input and
// output (ports, read/write/display, EOF objects) and §6.14 System interface
// (clock, environment variables, command line, exit).
//
// A DOORS-ONLY capability. arrival is a PURE INFERENCE PLANE: it ships NO IO surface
// and NO ambient system interface, because both are EFFECTS with no value-
// construction site for provenance to root at (IO is ambient; the clock / env /
// exit are non-deterministic). They are omitted BY DESIGN; each door (errors-as-
// doors) teaches the why and routes the caller back to pure dataflow.
//
// ─── HOME DECISION (flagged for review) ──────────────────────────────────────────
// §6.13 and §6.14 are WHOLE-section omissions — arrival ships no ports or system
// subsystem, so no existing pack "owns" them. They share one rationale (host effects
// have no construction-site), so they get ONE dedicated host pack here rather than
// being scattered, or left "aside" in a manifest. This completes the dissolution of
// the central `_unimplemented.ts` manifest into live, teaching capabilities. If
// review prefers, this pack is the most trimmable part of the change — it adds only
// teaching doors, none of them test-load-bearing.
//
// SINGLE SOURCE: `r7rs/index.ts` adds this to `allR7rs`, so `base-packs.ts`
// assembles it into the base env.

import { EnvCapability } from "../../common/capability.js";
import { symbol, type SymbolDef } from "../../common/symbol.js";

// §6.13 — no IO surface in the inference plane (an ambient effect, no construction-site).
const IO_REASON =
  "ports & IO are omitted from arrival by design — it is a pure inference plane with no IO surface; an ambient read/write has no value-construction site for provenance. Return the value from your dataflow instead of streaming it out";

// §6.14 — ambient / non-deterministic, no place in a provenance-grounded plane.
const SYSTEM_REASON =
  "the system interface is omitted from arrival by design — clock, environment, command line and exit are ambient and non-deterministic, with no construction-site to root a value's lineage at; pass any context you need in explicitly";

/** A teaching door for one omitted host verb (interpolated name + shared per-section reason). */
const door = (name: string, reason: string): SymbolDef => symbol.notImplemented`${name}: ${reason}`;

// §6.13 Input and output — ports, character/string IO, EOF objects.
const IO_VERBS = [
  "current-output-port",
  "current-input-port",
  "current-error-port",
  "open-input-string",
  "open-output-string",
  "read",
  "read-char",
  "write-char",
  "write-string",
  "write",
  "display",
  "newline",
  "eof-object",
  "eof-object?",
];

// §6.14 System interface — clock, environment, command line, process exit.
const SYSTEM_VERBS = [
  "current-second",
  "current-jiffy",
  "jiffies-per-second",
  "get-environment-variable",
  "get-environment-variables",
  "command-line",
  "exit",
  "emergency-exit",
];

const symbols: Record<string, SymbolDef> = {};
for (const verb of IO_VERBS) symbols[verb] = door(verb, IO_REASON);
for (const verb of SYSTEM_VERBS) symbols[verb] = door(verb, SYSTEM_REASON);

export default new EnvCapability("scheme/r7rs/host", { symbols });
