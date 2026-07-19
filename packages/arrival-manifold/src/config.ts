// config — reads the STANDARD `mcpServers` shape (Claude Desktop / Claude Code's `.mcp.json`
// convention: one object keyed by server name). No new format to learn — point this at a
// config you already have. Each entry is EITHER stdio (`command`) OR http (`url`), never
// both, never neither.

import type { TypeHintsMode } from "@inhuman.tools/mcp-substrate";
import * as z from "zod";

import type { AttestationMode } from "./bind.js";

/** Per-server entry: stdio OR http. `tools` is the optional per-server tool allowlist —
 *  absent means every tool binds; present means ONLY these, naming a missing tool is a
 *  loud config error (typo guard). */
const mcpServerEntry = z.object({
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  url: z.string().min(1).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  tools: z.array(z.string().min(1)).optional(),
});

const catalogConfig = z.object({
  detail: z.enum(["full", "summary"]).optional(),
  summaryText: z.string().min(1).optional(),
});

const mcpServersFile = z.object({
  /** Key is the server slug. An EMPTY slug binds this server's tools by their BARE
   *  names (single-server shape; see bind.ts). */
  mcpServers: z.record(z.string(), mcpServerEntry),
  /** Per-eval wall-clock budget in ms (H-1). Absent ⇒ manifold-tool's default. */
  evalTimeoutMs: z.number().int().positive().optional(),
  /** Catalog-detail parity harness. Absent ⇒ "full" (byte-identical catalog). */
  catalog: catalogConfig.optional(),
  /** Branded attestation knob. Absent ⇒ "available". */
  attestation: z.enum(["off", "available", "required"]).optional(),
  /** Observation rendering. Absent ⇒ "braces". "sexpr" escapes back to constructor form. */
  rendering: z.enum(["braces", "sexpr"]).optional(),
  /** Observation size budget in chars. Absent ⇒ render-observation.ts's 20k. */
  observation: z
    .object({
      maxTotalChars: z.number().int().positive().optional(),
    })
    .optional(),
  /** Opt-in metadata prompt-fields (focused-reasoning substrate; enabled per-deploy
   *  when it helps, dead weight on strong models). */
  promptFields: z.object({ intent: z.boolean().optional(), successCriteria: z.boolean().optional() }).optional(),
  /** Type-hints whole-feature kill switch. Absent ⇒ "telemetry" (safe default; measure,
   *  don't render). Per-code demotion is a code edit, never a config knob. */
  typeHints: z.enum(["off", "telemetry", "on-error"]).optional(),
});

export type ManifoldServerConfig =
  | {
      name: string;
      transport: "stdio";
      command: string;
      args?: string[];
      env?: Record<string, string>;
      tools?: string[];
    }
  | { name: string; transport: "http"; url: string; headers?: Record<string, string>; tools?: string[] };

export interface ManifoldConfig {
  servers: readonly ManifoldServerConfig[];
  evalTimeoutMs?: number;
  catalog?: { detail?: "full" | "summary"; summaryText?: string };
  attestation?: AttestationMode;
  rendering?: "braces" | "sexpr";
  observation?: { maxTotalChars?: number };
  promptFields?: { intent?: boolean; successCriteria?: boolean };
  typeHints: TypeHintsMode;
}

function toServerConfig(name: string, entry: z.infer<typeof mcpServerEntry>): ManifoldServerConfig {
  const hasCommand = entry.command !== undefined;
  const hasUrl = entry.url !== undefined;
  if (hasCommand === hasUrl) {
    throw new Error(
      `invalid manifold config: mcpServers.${name} must have exactly one of "command" (stdio) or "url" (http)`,
    );
  }
  return hasCommand
    ? { name, transport: "stdio", command: entry.command!, args: entry.args, env: entry.env, tools: entry.tools }
    : { name, transport: "http", url: entry.url!, headers: entry.headers, tools: entry.tools };
}

/** Deploy-time override from `MANIFOLD_TYPE_HINTS` — applies over `config.typeHints`.
 *  Unset/empty ⇒ undefined (no override); non-mode value is a LOUD error. */
export function typeHintsModeFromEnv(raw: string | undefined): TypeHintsMode | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw === "off" || raw === "telemetry" || raw === "on-error") return raw;
  throw new Error(`invalid MANIFOLD_TYPE_HINTS value "${raw}" — expected "off" | "telemetry" | "on-error"`);
}

/** Deploy-time override from `ARRIVAL_RESPONSE_CHARACTER_CAP` — same precedence as
 *  `typeHintsModeFromEnv`: applies over `config.observation?.maxTotalChars`, itself
 *  overridden by a `--response-character-cap` CLI flag. */
export function responseCharacterCapFromEnv(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid ARRIVAL_RESPONSE_CHARACTER_CAP value "${raw}" — expected a positive integer`);
  }
  return parsed;
}

export function parseManifoldConfig(raw: unknown): ManifoldConfig {
  const result = mcpServersFile.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
    throw new Error(`invalid manifold config: ${issues}`);
  }
  const entries = Object.entries(result.data.mcpServers);
  if (entries.length === 0) {
    throw new Error("invalid manifold config: mcpServers must have at least one entry");
  }
  if (result.data.catalog?.detail === "summary" && !result.data.catalog.summaryText) {
    throw new Error('invalid manifold config: catalog.detail "summary" requires a non-empty catalog.summaryText');
  }
  return {
    servers: entries.map(([name, entry]) => toServerConfig(name, entry)),
    evalTimeoutMs: result.data.evalTimeoutMs,
    catalog: result.data.catalog,
    attestation: result.data.attestation,
    rendering: result.data.rendering,
    observation: result.data.observation,
    promptFields: result.data.promptFields,
    typeHints: result.data.typeHints ?? "telemetry",
  };
}
