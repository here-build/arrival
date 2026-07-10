/**
 * confirm-burst — the second MCP tool of the provenance-offloaded confirmation
 * design (docs/working-proposals/arrival-provenance-confirmation.md). Submits the
 * approved subset of a held `ConfirmManifest`; that submission IS the burst — the
 * approved effects fire, in original order, through `DiscoveryTool.confirmBurst`
 * (which owns the session/warm-ambient machinery this thin wrapper never
 * duplicates: same session state, same warm `(AssembledAmbient, LexicalScope)`
 * pair the discovery tool itself reuses).
 *
 * A wrong digest is a "which manifest?" teaching door (§7.1); fill-or-kill
 * (§7.3) means a declined effect leaves no durable trace — only re-issuing the
 * original program re-offers it, never a retry of just the decline.
 */

import type { Tool } from "@modelcontextprotocol/sdk/types.js";

import type { DiscoveryTool, ToolCallCtx } from "./DiscoveryTool.js";
import type { ManifestRow } from "./confirm-manifest.js";

// ─────────────────────────────────────────────────────────────────────────────
// The per-effect rig-altered invariant — SEAM, not built (task-scoped honesty:
// this wave ships the digest check + fill-or-kill; the world-drift invariant
// needs a live re-derivation channel W3's plexus burst executor would supply,
// docs/working-proposals/arrival-plexus-effect-burst.md §2.6/W4 — arrival-mcp's
// DiscoveryTool is capability-agnostic and has no such channel today).
// ─────────────────────────────────────────────────────────────────────────────

/** One row's rig-altered verdict. `altered: true` dooors THAT row only — siblings
 *  still fire (§7's W4 gate text: "effect i doors … siblings unaffected"). */
export interface RigAlteredResult {
  readonly altered: boolean;
  /** Present iff altered — what changed, for the teaching door text. */
  readonly detail?: string;
}

/** Re-derive (or refuse to re-derive) whether the world moved under ONE approved
 *  row since the manifest was built. `row.invocationSource` is the re-runnable
 *  program a real implementation would re-derive args FROM (an uneval-slice /
 *  writeSetOf re-derivation over the row's own argument cone — see the design
 *  doc's §7.1/Part V.3). */
export type RigAlteredCheck = (row: ManifestRow) => RigAlteredResult | Promise<RigAlteredResult>;

/** The HONEST default: no re-derivation channel is wired, so every row reports
 *  unaltered — never a fabricated check. A host with a real writeSetOf/uneval-slice
 *  re-derivation channel (e.g. once W3's plexus burst executor lands) passes its
 *  own `RigAlteredCheck` to {@link DiscoveryToolOptions.rigAlteredCheck} instead. */
export const noRigAlteredCheck: RigAlteredCheck = () => ({ altered: false });

// ─────────────────────────────────────────────────────────────────────────────
// The tool
// ─────────────────────────────────────────────────────────────────────────────

export interface ConfirmBurstArgs {
  /** §7.1: manifest IDENTITY only — which held manifest this call approves against. */
  readonly digest: string;
  /** The subset of `ManifestRow.effectIndex` values to fire. Bursts in ORIGINAL
   *  program order regardless of the array's order (§5: "approve 3 of 5, only
   *  those burst"); indexes outside the manifest's rows door (a teaching error
   *  naming the valid set), never silently ignored. */
  readonly approvedEffectIndexes: readonly number[];
}

/** A thin MCP-tool-shaped wrapper over `DiscoveryTool.confirmBurst` — deliberately
 *  NOT a second session/ambient implementation: confirmation must fire through the
 *  SAME warm ambient + session state the discovery tool itself holds (the pending
 *  manifest lives in that same `SessionRunState`), so this class only forwards. */
export class ConfirmBurstTool {
  constructor(
    readonly name: string,
    private readonly discovery: DiscoveryTool,
    private readonly description?: string,
  ) {}

  async describe(): Promise<Tool> {
    return {
      name: this.name,
      description:
        this.description ??
        "Submit the approved subset of a held confirm-manifest's effects (from a prior discovery-tool " +
          "call that returned one because it gathered a risky effect). The approved subset bursts in " +
          "original program order. A wrong digest refuses with the current pending manifest's identity, " +
          "if any. Declined effects leave no durable trace — re-issue the original program to re-offer them.",
      inputSchema: {
        type: "object",
        properties: {
          digest: { type: "string", description: "The manifest's own digest — echoed back from the held response." },
          approvedEffectIndexes: {
            type: "array",
            items: { type: "number" },
            description: "Which ManifestRow.effectIndex values to fire; the rest are declined (fill-or-kill).",
          },
        },
        required: ["digest", "approvedEffectIndexes"],
      },
      annotations: { readOnlyHint: false },
    };
  }

  async call(args: ConfirmBurstArgs, ctx: ToolCallCtx = {}): Promise<(string | Blob)[]> {
    return this.discovery.confirmBurst(args, ctx);
  }
}
