/**
 * The `this` brand a native / generator-lambda is applied with at the call chokepoint
 * (call-function.ts). Its whole job is IDENTITY: the membrane keys off this class
 * (`instanceof`) to pass a call through unwrapped — no payload field is ever read. (Its
 * former `use_dynamic` field was dead plumbing, retired in the Stage-C trails cleanup
 * alongside the `dynamic_env`/`use_dynamic` chain it was fed from.)
 *
 * The private `#brand` is NOT data — TS structural typing means a truly empty class body
 * is indistinguishable from `{}`, which is assignable from nearly any non-nullish value;
 * `membrane.ts`'s `BoxedSchemeValue` union (which includes `LambdaContext`) would then
 * silently absorb unrelated types, breaking `instanceof` narrowing elsewhere (AmbientRuntime.ts's
 * `bindValue`). The brand exists only to keep this class nominally distinct.
 */
export class LambdaContext {
  readonly #brand = "LambdaContext" as const;
}
