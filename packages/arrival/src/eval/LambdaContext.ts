import type { BindingName, Environment, EnvironmentValue } from "../Environment.js";

interface LambdaContextPayload {
  env: Environment;
  dynamic_env?: Environment;
  use_dynamic?: boolean;
}

export class LambdaContext {
  declare env: Environment;
  declare dynamic_env: Environment;
  declare use_dynamic: boolean;

  constructor(payload: LambdaContextPayload) {
    Object.assign(this, payload);
  }

  get(symbol: BindingName, options?: { throwError?: boolean }): EnvironmentValue {
    return this.env.get(symbol, options);
  }
}
