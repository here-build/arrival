interface LambdaContextPayload {
  use_dynamic?: boolean;
}

/**
 * The `this` brand a native / generator-lambda is applied with at the call chokepoint
 * (call-function.ts). Post-P3-3b.3-step-6 it carries only `use_dynamic`; the `env` /
 * `dynamic_env` frame fields + the `get` accessor were the vestigial legacy path — always
 * undefined (callers pass `{}`) and read by nothing — and were dissolved (seeds P5). The
 * membrane keys off this class's identity (`instanceof`) to pass it through unwrapped; no
 * field is read.
 */
export class LambdaContext {
  declare use_dynamic: boolean;

  constructor(payload: LambdaContextPayload) {
    Object.assign(this, payload);
  }
}
