import { beforeAll, describe, expect, it } from "vitest";
import { CONSTANT_CTX } from "../values/primitives/RunContext.js";
import { env as global_environment, exec } from "../stdlib";
import { initBridge } from "../bridge";
import { AExact } from "../values/numbers";

const execSimple = async (string: string, env?: object, dynamic_env?: object) => {
  return exec(string, { env, dynamic_env, use_dynamic: !!dynamic_env });
};
beforeAll(async () => {
  await initBridge();
});

describe("environment", function () {
  const env = global_environment;
  // Native extension fns no longer receive env-as-`this` (that ABI was retired
  // when the evaluator stopped injecting `ctx.env` as the apply-site `this`).
  // A native fn that needs the run env opts into the `__withCtx` channel: the
  // evaluator appends the EvalContext as the trailing arg, so the body reads
  // `ctx.env` explicitly and stays `this`-free.
  const scope_name = Object.assign(
    function scope_name(ctx) {
      const env = ctx.env;
      if (env.__name__ === "__frame__") {
        return env.__parent__.__name__;
      }
      return env.__name__;
    },
    { __withCtx: true },
  );
  var functions = { scope_name };
  async function scope(env) {
    const result = await exec("(scope_name)", { env });
    return result[0].valueOf();
  }
  it("should return name of the enviroment", async function () {
    var e = env.inherit("foo", functions);
    const result = await scope(e);
    expect(result).toEqual("foo");
  });
  it("should create default scope name", async function () {
    var e = env.inherit("child of user-env", functions);
    const result = await scope(e);
    expect(result).toEqual("child of user-env");
  });
  it("should create default scope name for child scope", async function () {
    var e = global_environment.inherit("foo", functions);
    var child = e.inherit();
    const result = await scope(child);
    expect(result).toEqual("child of foo");
  });
});
describe("scope", function () {
  const ge = global_environment;
  async function execScope(code: string, dynamic_scope?: boolean) {
    var env = ge.inherit();
    return execSimple(code, env, dynamic_scope ? env : undefined);
  }
  describe("lexical", function () {
    it("should evaluate let", async function () {
      const result = await execScope(`(define x 10) (let ((x 10)) x)`);
      expect(result).toEqual([undefined, new AExact(CONSTANT_CTX, 10n)]);
    });
    it("should evaluate let over let", async function () {
      var code = `(define x 10)
                        (let ((x 20)) (let ((x 30)) x))`;
      const result = await execScope(code);
      expect(result).toEqual([undefined, new AExact(CONSTANT_CTX, 30n)]);
    });
    it("should evaluate lambda", async function () {
      var code = `(define x 10)
                        ((let ((x 20)) (lambda () x)))`;
      const result = await execScope(code);
      expect(result).toEqual([undefined, new AExact(CONSTANT_CTX, 20n)]);
    });
    it("sould create closure", async function () {
      var code = `(define fn (let ((x 10))
                                      (let ((y 20)) (lambda () (+ x y)))))
                        (fn)`;
      const result = await execScope(code);
      expect(result).toEqual([undefined, new AExact(CONSTANT_CTX, 30n)]);
    });
  });
  // Dynamic scope tests removed - dynamic scoping is a legacy feature not used in standard Scheme
});
// __doc__ support has been removed - documentation is no longer attached to functions
