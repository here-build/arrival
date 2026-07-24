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

import { EnvCapability, schemeToJs, z, type SchemeValue } from "@inhuman.tools/arrival";

import { type HttpEffectResolver, type HttpMethod, httpOptions, inertHttpResolver } from "./http-effect.js";

export const arrivalHttpCapability = EnvCapability.define("arrival/http", {
  // Structural validator (not bare `z.custom<T>()`): a resolver is a fn seam — assert callable so a
  // malformed host wiring fails loud at lower() rather than at the first http effect.
  configuration: { http: z.custom<HttpEffectResolver>((v) => typeof v === "function").optional() },
  // FLIPPED form (EnvCapability.define): this `symbols` callback runs EAGERLY, ONCE, at define()
  // time — config-independent — so the host `http` resolver can't be resolved out here. Each impl
  // re-reads it from `this.configuration.http` at REAL DISPATCH instead (the injected
  // `symbol.rosetta`'s typed `this` — `this.invocation` rides the same CallCtx channel it always
  // did). VARIADIC identity input (`z.array(z.dynamic)`) keeps open ARITY TOLERANCE (opts
  // may be omitted). Each arg is `schemeToJs`'d explicitly inside the impl (crossing face).
  // Each verb is a `symbol.rosetta` SOURCE (no pure-pipe ⇒ mints a fresh provenance point at the
  // membrane crossing).
  symbols: (symbol) => {
    const httpVerb = (method: HttpMethod, name: "http/get" | "http/post") =>
      symbol.rosetta`${name}: performs an ${method} request via the http effect resolver`(
        { input: z.array(z.dynamic), output: [z.dynamic], type: "(label: string, path: string, opts?: unknown): unknown" },
        // Boundary assert: the resolver returns unknown by design (host data); the z.dynamic
        // contract demands SchemeValue — asserted at the verb table, same as arrival-reflect.
        function (...args: unknown[]) {
          const resolve = this.configuration.http ?? inertHttpResolver;
          // Boundary narrow: the verb table receives raw scheme args (unknown[]); schemeToJs's
          // honest signature demands SchemeValue — asserted once at the destructure, same as
          // the boundary-assert return cast below.
          const [label, path, opts] = args as (SchemeValue | undefined)[];
          // Boundary assert: the resolver returns `Promise<unknown>` by design (host data); the
          // z.dynamic contract demands `MaybePromise<SchemeValue>` — asserted at the return, same
          // as arrival-reflect (kept narrow to the return value so the impl's `this` still
          // contextually infers as `ImplThis<Config, Resources>` off the injected `symbol.rosetta`).
          return resolve(this.invocation, {
            kind: "http",
            method,
            label: String(schemeToJs(label, {})),
            path: String(schemeToJs(path, {})),
            ...httpOptions(method, schemeToJs(opts, {})),
          }) as Promise<SchemeValue>;
        },
      );

    return {
      "http/get": httpVerb("GET", "http/get"),
      "http/post": httpVerb("POST", "http/post"),
    };
  },
});
