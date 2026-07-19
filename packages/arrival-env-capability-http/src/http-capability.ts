// arrivalHttpCapability — the http-effect membrane (`http/get`, `http/post`).
//
// Inert by construction: when the host doesn't arm `http`, the verbs fall back to
// `inertHttpResolver`, which THROWS a teaching error at call time — so the OSS engine ships the
// verbs present but disarmed, never reaching a network and never silently no-op'ing. The SaaS
// host injects the credentialed resolver via config.
//
// The verbs are BAKED `symbol.rosetta` declarations (no `captureSymbols` recording). Arg
// shaping (`httpOptions`) is imported straight from `http-effect.ts` — one shaping
// implementation, one registration site.

import { EnvCapability, schemeToJs, symbol, z, type SchemeValue } from "@inhuman.tools/arrival";

import {
  type HttpEffectResolver,
  type HttpMethod,
  httpOptions,
  inertHttpResolver,
} from "./http-effect.js";

/** The per-call invocation-`this` these verbs read: the `{ currentInvocation }` carrier forwarded
 *  to the host resolver (mirrors `arrivalInferCapability`'s `InferInvocation` in env-infer's
 *  `infer.ts` — same seam shape, ctx arrives via `this`, not a param). */
interface HttpInvocation {
  readonly invocation: { currentInvocation: unknown };
}

export const arrivalHttpCapability = new EnvCapability("arrival/http", {
  // Structural validator (not bare `z.custom<T>()`): a resolver is a fn seam — assert callable so a
  // malformed host wiring fails loud at lower() rather than at the first http effect.
  configuration: { http: z.custom<HttpEffectResolver>((v) => typeof v === "function").optional() },
  // BUILDER form: the host `http` resolver arrives via the activation closure — a baked rosetta is
  // bound raw (`this` is the invocation-context, NOT the activation), so config can't ride `this`.
  // VARIADIC identity input (`z.array(z.value)`) keeps the legacy ARITY TOLERANCE (opts
  // may be omitted). Each arg is `schemeToJs`'d explicitly inside the impl — byte-identical to the
  // legacy generic membrane's automatic `schemeToJs` pass every `defineRosetta` arg went through.
  // Each verb is a `symbol.rosetta` SOURCE (no `pure` ⇒ mints a fresh provenance point at the
  // membrane crossing, exactly as the former `withContext` rosettas did).
  symbols: ({ configuration }) => {
    const resolve = configuration.http ?? inertHttpResolver;

    const httpVerb = (method: HttpMethod, name: "http/get" | "http/post") =>
      symbol.rosetta`${name}: performs an ${method} request via the http effect resolver`(
        { input: z.array(z.value), output: [z.value], type: "(label: string, path: string, opts?: unknown): unknown" },
        // Boundary assert: the resolver returns unknown by design (host data); the z.value
        // contract demands SchemeValue — asserted at the verb table, same as arrival-reflect.
        function (this: HttpInvocation, ...args: unknown[]) {
          // Boundary narrow: the verb table receives raw scheme args (unknown[]); schemeToJs's
          // honest signature demands SchemeValue — asserted once at the destructure, same as
          // the impl-level `as never` this table already carries.
          const [label, path, opts] = args as (SchemeValue | undefined)[];
          return resolve(this.invocation, {
            kind: "http",
            method,
            label: String(schemeToJs(label, {})),
            path: String(schemeToJs(path, {})),
            ...httpOptions(method, schemeToJs(opts, {})),
          });
        } as never,
      );

    return {
      "http/get": httpVerb("GET", "http/get"),
      "http/post": httpVerb("POST", "http/post"),
    };
  },
});
