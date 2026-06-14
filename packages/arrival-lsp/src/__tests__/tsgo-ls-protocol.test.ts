// tsgo-ls-protocol — the reusable types-first artifact over the wire: the
// tsgo scheme service served on a MessageChannel speaks the EXISTING
// ls-protocol, so connectSchemeLs (and therefore use-scheme-ide and every
// AsyncSchemeLanguageService consumer) mounts it unchanged.

import { describe, expect, it } from "vitest";

import { connectSchemeLs } from "../ls-client.js";
import { getPreludeFiles } from "../prelude.js";
import { serveTsgoSchemeLs } from "../tsgo/ls-server.js";
import { spawnTsgoNodeTransport, tsgoWasmAvailable } from "../tsgo/node-transport.js";

const asPort = (
  p: { postMessage(d: unknown): void },
): { postMessage(d: unknown): void; onmessage: ((ev: { data: unknown }) => void) | null } => p as never;

const wasmPresent = tsgoWasmAvailable();
if (!wasmPresent) {
  console.warn("[tsgo-ls-protocol] SKIPPED — no tsgo wasm artifact.");
}

describe.skipIf(!wasmPresent)("tsgo LS over the ls-protocol wire", () => {
  it("connectSchemeLs mounts the tsgo service unchanged", { timeout: 60_000 }, async () => {
    const channel = new MessageChannel();
    serveTsgoSchemeLs(
      asPort(channel.port1),
      { service: null, profile: null },
      { preludeFiles: getPreludeFiles, transport: () => spawnTsgoNodeTransport() },
    );
    const ls = await connectSchemeLs(asPort(channel.port2), {});

    const diags = await ls.getSemanticDiagnostics("(car 5)\n");
    expect(diags.some((d) => d.code === 2345)).toBe(true);

    const valid = await ls.getTypeValidCandidates("(car ", 5, ["list", "length", "car"]);
    expect(valid).toContain("list");
    expect(valid).not.toContain("length");

    await ls.setProjectFiles({ "lib.scm": "(define shared (list 1 2))" });
    const withDep = await ls.getSemanticDiagnostics('(require "lib.scm")\n(car shared)\n');
    expect(withDep.filter((d) => d.severity === "error")).toEqual([]);

    const ctx = await ls.getCompletionContext("(map double ", 12);
    expect(ctx.position).toBe("argument");
  });
});
