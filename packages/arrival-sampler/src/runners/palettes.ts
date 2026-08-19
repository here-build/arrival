// palettes.ts — the NODE-side "action palettes" API the explain-demo server consumes.
//
// A *palette* is the SAME apple action surface (APPLE_INTENTS) re-presented under ONE naming SCHEME
// (apple-namespaced.ts). Picking a palette lets the demo choose which tool-naming surface the model
// generates against. Each palette wraps the scheme's three builders verbatim:
//   • paletteTools(id)   = namespacedAppleTools(id)                         — { name, arity }[]
//   • buildPaletteEnv(id)= { capabilities, scope, grant } of makeNamespacedDeviceSim(id)
//                          — `makeOracle(grant)` / `exec({ capabilities, scope })` consume
//   • buildPalettePrompt = buildNamespacedApplePrompt(id)                   — system prompt listing tool names
//
// This module is NODE-ONLY (makeNamespacedDeviceSim defines a real EnvCapability). It is exposed through
// the package's `./palettes` node subpath, compiled into dist-server/ — the browser `.` entry never
// imports it.

import {
  appleName,
  buildNamespacedApplePrompt,
  makeNamespacedDeviceSim,
  namespacedAppleTools,
  type Scheme,
} from "./apple-namespaced.js";
import { APPLE_INTENTS } from "./fixtures/apple-intents/registry.js";

export type PaletteId = Scheme;

export interface PaletteInfo {
  readonly id: PaletteId;
  /** Human-friendly recombination, e.g. "Domain / Entity / Intent". */
  readonly label: string;
  /** One line: how this scheme names tools + a concrete example. */
  readonly description: string;
  /** One concrete tool name under this scheme (the send-message tool). */
  readonly sampleName: string;
  readonly toolCount: number;
  /** Measured correctness from measurement-trust.md — known only for bdei/bang/die. */
  readonly measuredCorrectness?: number;
}

/** The send-message tool is the canonical example across schemes (messaging/message/send). */
const SAMPLE_TOOL = APPLE_INTENTS.find((tool) => tool.name === "send-message")!;
const sampleName = (id: PaletteId): string => appleName(SAMPLE_TOOL, id);
const toolCount = (id: PaletteId): number => namespacedAppleTools(id).length;

/**
 * The seven schemes as palettes. Orderings/recombinations are taken verbatim from apple-namespaced.ts's
 * own header comments — `send-message` (Messaging domain, query=false → effect/!effect) is the example.
 * Ordered best→worst where measured (bdei 0.843, bang 0.786, die 0.571) then the remaining, unmeasured.
 */
const META: ReadonlyArray<Omit<PaletteInfo, "sampleName" | "toolCount">> = [
  {
    id: "bdei",
    label: "Sigil ! / ? · Domain / Entity / Intent",
    description: "Sigil effect/query cue on the full domain, entity-first: !effect/messaging/message/send",
    measuredCorrectness: 0.843,
  },
  {
    id: "bang",
    label: "!Effect | !Query · Entity / Intent",
    description: "Bang-cued read-vs-mutate root, entity-first: !effect/message/send",
    measuredCorrectness: 0.786,
  },
  {
    id: "die",
    label: "Domain / Intent / Entity",
    description: "Domain group, intent-first within domain: messaging/send/message",
    measuredCorrectness: 0.571,
  },
  {
    id: "dei",
    label: "Domain / Entity / Intent",
    description: "Domain group, entity-first within domain: messaging/message/send",
  },
  {
    id: "eq",
    label: "Effect | Query · Entity / Intent",
    description: "Read-vs-mutate kind replaces the domain, entity-first: effect/message/send",
  },
  {
    id: "bdie",
    label: "Sigil ! / ? · Domain / Intent / Entity",
    description: "Sigil effect/query cue on the full domain, intent-first: !effect/messaging/send/message",
  },
  {
    id: "env",
    label: "Env · Effect | Query · Entity / Intent",
    description: "An env/ head over the read-vs-mutate kind, entity-first: env/effect/message/send",
  },
];

export const PALETTES: readonly PaletteInfo[] = META.map((meta) => ({
  ...meta,
  sampleName: sampleName(meta.id),
  toolCount: toolCount(meta.id),
}));

export function paletteTools(id: PaletteId): { name: string; arity: number }[] {
  return namespacedAppleTools(id);
}

/** The Stage-C grant surface for a palette — hand `grant` to `makeOracle` (Σ) or
 *  `{ capabilities, scope }` to `exec`. */
export async function buildPaletteEnv(
  id: PaletteId,
): Promise<Pick<Awaited<ReturnType<typeof makeNamespacedDeviceSim>>, "capabilities" | "scope" | "grant">> {
  const { capabilities, scope, grant } = await makeNamespacedDeviceSim(id);
  return { capabilities, scope, grant };
}

export function buildPalettePrompt(id: PaletteId): string {
  return buildNamespacedApplePrompt(id);
}
