// arrivalSqlCapability — the sql-effect membrane (`sql/query`).
//
// Inert by construction: when the host doesn't arm `sql`, the verb falls back to
// `inertSqlResolver`, which THROWS a teaching error at call time — so the OSS engine ships the
// verb present but disarmed, never reaching a database and never silently no-op'ing. The SaaS
// host injects the credentialed resolver via config.
//
// The verb is a BAKED `symbol.rosetta` declaration (no `captureSymbols` recording). Arg
// shaping (`sqlParams`) is imported straight from `sql-effect.ts` — one shaping
// implementation, one registration site.

import { EnvCapability, schemeToJs, z, type SchemeValue } from "@inhuman.tools/arrival";

import { type SqlEffectResolver, inertSqlResolver, sqlParams } from "./sql-effect.js";

export const arrivalSqlCapability = EnvCapability.define("arrival/sql", {
  // Structural validator (not bare `z.custom<T>()`): a resolver is a fn seam — assert callable so a
  // malformed host wiring fails loud at lower() rather than at the first sql effect.
  configuration: { sql: z.custom<SqlEffectResolver>((v) => typeof v === "function").optional() },
  // FLIPPED form (EnvCapability.define): this `symbols` callback runs EAGERLY, ONCE, at define()
  // time — config-independent — so the host `sql` resolver can't be resolved out here. The impl
  // re-reads it from `this.configuration.sql` at REAL DISPATCH instead (the injected
  // `symbol.rosetta`'s typed `this` — `this.invocation` rides the same CallCtx channel it always
  // did). VARIADIC identity input (`z.array(z.value)`) keeps the legacy ARITY TOLERANCE (params
  // may be omitted). Each arg is `schemeToJs`'d explicitly inside the impl — byte-identical to the
  // legacy generic membrane's automatic `schemeToJs` pass every `defineRosetta` arg went through.
  // The verb is a `symbol.rosetta` SOURCE (no `pure` ⇒ mints a fresh provenance point at the
  // membrane crossing, exactly as the former `withContext` rosettas did).
  symbols: (symbol) => ({
    "sql/query": symbol.rosetta`sql/query: executes a sql query via the sql effect resolver`(
      { input: z.array(z.value), output: [z.value], type: "(label: string, query: string, params?: unknown): unknown" },
      // Boundary assert: the resolver returns unknown by design (host data); the z.value
      // contract demands SchemeValue — asserted at the verb table, same as arrival-reflect.
      function (...args: unknown[]) {
        const resolve = this.configuration.sql ?? inertSqlResolver;
        // Boundary narrow: the verb table receives raw scheme args (unknown[]); schemeToJs's
        // honest signature demands SchemeValue — asserted once at the destructure, same as
        // the boundary-assert return cast below.
        const [label, query, params] = args as (SchemeValue | undefined)[];
        // Boundary assert: the resolver returns `Promise<unknown>` by design (host data); the
        // z.value contract demands `MaybePromise<SchemeValue>` — asserted at the return, same
        // as arrival-reflect (kept narrow to the return value so the impl's `this` still
        // contextually infers as `ImplThis<Config, Resources>` off the injected `symbol.rosetta`).
        return resolve(this.invocation, {
          kind: "sql",
          label: String(schemeToJs(label, {})),
          query: String(schemeToJs(query, {})),
          params: sqlParams(schemeToJs(params, {})),
        }) as Promise<SchemeValue>;
      },
    ),
  }),
});
