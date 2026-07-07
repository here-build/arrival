interface LambdaContextPayload {
  use_dynamic?: boolean;
}

/**
 * The `this` brand a native / generator-lambda is applied with at the call chokepoint
 * (call-function.ts). Carries only `use_dynamic` — no frame/env fields, callers pass `{}`.
 * The membrane keys off this class's identity (`instanceof`) to pass it through unwrapped;
 * no field is read there.
 */
export class LambdaContext {
  declare use_dynamic: boolean;

  constructor(payload: LambdaContextPayload) {
    Object.assign(this, payload);
  }
}
