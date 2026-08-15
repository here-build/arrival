/**
 * The `(http/*)` MEMBRANE — real scheme forms crossing `arrivalHttpCapability` into
 * a stub resolver. This is the coverage the old `defineDataEffectRosettas` membrane
 * suite used to attempt over a bare frame (deleted as broken when the registration
 * path changed); the capability era's idiom runs the real assembly: `exec` with the
 * capability rooted and a per-call config, exactly as production arms it.
 */
import { exec } from "@inhuman.tools/arrival";
import { describe, expect, it } from "vitest";

import { arrivalHttpCapability } from "../http-capability.js";
import type { HttpEffect, HttpEffectResolver } from "../http-effect.js";

/** Run scheme against a per-call assembly of the http verbs; return the last (awaited)
 *  value. `exec` already exits through `toJS` — no second peel. */
async function runScm(scm: string, resolve?: HttpEffectResolver): Promise<unknown> {
  const r = await exec(scm, { capabilities: [arrivalHttpCapability], config: resolve ? { http: resolve } : {} });
  const last = r.at(-1);
  return last && typeof (last as { then?: unknown }).then === "function" ? await last : last;
}

/** A stub resolver that records every descriptor it receives, then replies. */
function recordingResolver(reply: unknown): { resolve: HttpEffectResolver; seen: HttpEffect[] } {
  const seen: HttpEffect[] = [];
  const resolve: HttpEffectResolver = async (_ctx, effect) => {
    seen.push(effect);
    return reply;
  };
  return { resolve, seen };
}

describe("(http/get …) — the read verb", () => {
  it("canonicalises label/path into the descriptor and hands the resolver's reply back to scheme", async () => {
    const { resolve, seen } = recordingResolver("sunny");
    const v = await runScm(`(http/get "weather-api" "/forecast")`, resolve);
    expect(v).toBe("sunny");
    expect(seen).toEqual([{ kind: "http", method: "GET", label: "weather-api", path: "/forecast" }]);
  });

  it("shapes (dict :query …) opts into the descriptor (scalars verbatim)", async () => {
    const { resolve, seen } = recordingResolver(null);
    await runScm(`(http/get "weather-api" "/forecast" (dict :query (dict :city "berlin" :days 3)))`, resolve);
    expect(seen).toEqual([
      { kind: "http", method: "GET", label: "weather-api", path: "/forecast", query: { city: "berlin", days: 3 } },
    ]);
  });

  it("a structured :query value is a verb-layer teaching error, never a lying cast", async () => {
    const { resolve } = recordingResolver(null);
    await expect(runScm(`(http/get "a" "/b" (dict :query (dict :f (dict :nested 1))))`, resolve)).rejects.toThrowError(
      /query param "f" must be a scalar/,
    );
  });

  it("an empty-list :query value crosses the membrane as a JS array — and rejects as non-scalar", async () => {
    // toJS lowers `(list)`/`'()` to `[]` at every depth (there is no Nil
    // instance on this path), so an empty-list field is a STRUCTURED value, not an
    // omitted one. The omission discipline (`isAbsentValue`) covers null/undefined,
    // which a scheme dict literal cannot express — it exists for JS-side callers.
    const { resolve } = recordingResolver(null);
    await expect(runScm(`(http/get "a" "/b" (dict :query (dict :since (list))))`, resolve)).rejects.toThrowError(
      /query param "since" must be a scalar \(string\/number\/boolean\), got array/,
    );
  });
});

describe("(http/post …) — the write verb", () => {
  it("carries a structured :body verbatim into the descriptor", async () => {
    const { resolve, seen } = recordingResolver({ id: 1 });
    const v = await runScm(`(http/post "crm" "/contacts" (dict :body (dict :name "ada" :tags (list "x" "y"))))`, resolve);
    expect(v).toEqual({ id: 1 });
    expect(seen).toEqual([
      { kind: "http", method: "POST", label: "crm", path: "/contacts", body: { name: "ada", tags: ["x", "y"] } },
    ]);
  });

  it("(dict :body (list)) crosses as an empty ARRAY — structure is the payload, even when empty", async () => {
    // toJS lowers `(list)` to `[]`; `coerceHttpBody` drops only null/undefined,
    // so the descriptor keeps `body: []` verbatim and the content key reflects it.
    const { resolve, seen } = recordingResolver(null);
    await runScm(`(http/post "crm" "/contacts" (dict :body (list)))`, resolve);
    expect(seen).toEqual([{ kind: "http", method: "POST", label: "crm", path: "/contacts", body: [] }]);
  });
});

describe("inert by default", () => {
  it("an unarmed environment throws the teaching error at call time (never a silent no-op)", async () => {
    await expect(runScm(`(http/get "weather-api" "/forecast")`)).rejects.toThrowError(
      /http effects are not enabled in this environment/,
    );
  });
});
