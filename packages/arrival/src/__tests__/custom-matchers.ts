import { expect } from "vitest";
import { execSerialized } from "../execSerialized";

declare module "vitest" {
  interface Assertion<T = any> {
    toExecuteInto(...expectedResults: string[]): Promise<void>;
  }
  interface AsymmetricMatchersContaining {
    toExecuteInto(...expectedResults: string[]): any;
  }
}

expect.extend({
  async toExecuteInto(received: string, ...expectedResults: string[]) {
    const { isNot } = this;
    
    try {
      const actualResults = await execSerialized(received);
      
      const pass = actualResults.length === expectedResults.length &&
        actualResults.every((result, index) => result === expectedResults[index]);
      
      if (pass) {
        return {
          message: () =>
            `expected ${received} not to execute into [${expectedResults.join(", ")}], but it did`,
          pass: true,
        };
      } else {
        return {
          message: () =>
            `expected ${received} to execute into [${expectedResults.join(", ")}], but got [${actualResults.join(", ")}]`,
          pass: false,
        };
      }
    } catch (error) {
      return {
        message: () =>
          `expected ${received} to execute successfully, but got error: ${error.message}`,
        pass: false,
      };
    }
  },
});