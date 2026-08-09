import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TSLanguageServiceWrapper } from "./ts-language-service";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { toSExpr } from "@inhuman.tools/arrival-serializer";

describe("Unified Analyze Action", () => {
  let service: TSLanguageServiceWrapper;
  let testDir: string;

  beforeEach(() => {
    service = new TSLanguageServiceWrapper();
    service.invalidateCache();
    testDir = join(tmpdir(), `ts-lsp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

    // Create a tsconfig.json
    writeFileSync(join(testDir, "tsconfig.json"), JSON.stringify({
      compilerOptions: {
        target: "es2020",
        module: "commonjs",
        strict: true,
        esModuleInterop: true
      },
      include: ["./**/*"]
    }, null, 2));
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should analyze symbol with multiple information bundles", async () => {
    const testFile = join(testDir, "analyze.ts");
    const repoFile = join(testDir, "repository.ts");

    // Create test files
    writeFileSync(repoFile, `
export interface Repository<T> {
  findById(id: string): Promise<T | null>;
  findAll(): Promise<T[]>;
  save(item: T): Promise<T>;
}

export abstract class BaseRepository<T> implements Repository<T> {
  abstract findById(id: string): Promise<T | null>;
  abstract findAll(): Promise<T[]>;
  abstract save(item: T): Promise<T>;
}
`);

    writeFileSync(testFile, `
import { Repository, BaseRepository } from './repository';

interface User {
  id: string;
  name: string;
  email: string;
}

class UserRepository extends BaseRepository<User> {
  private users: User[] = [];
  
  async findById(id: string): Promise<User | null> {
    return this.users.find(u => u.id === id) || null;
  }
  
  async findAll(): Promise<User[]> {
    return [...this.users];
  }
  
  async save(user: User): Promise<User> {
    this.users.push(user);
    return user;
  }
}

const repo = new UserRepository();
`);

    // Test analyzing UserRepository with multiple information bundles
    const result = await service.analyze(testFile, [
      {
        at: "class UserRepository###",
        want: {
          identity: true,
          location: true,
          type: { expanded: true },
          hierarchy: { implementations: true },
          members: true
        }
      }
    ]);

    expect(result).toBeDefined();
    const sexpr = toSExpr(result);

    // Should be wrapped in (analysis ...)
    expect(sexpr[0]).toBe("analysis");

    // Get the symbol info
    const symbolInfo = sexpr[1];
    expect(symbolInfo[0]).toBe("symbol");
    expect(symbolInfo[1]).toBe("UserRepository");

    // Check for location info
    const atIndex = symbolInfo.indexOf(":at");
    expect(atIndex).toBeGreaterThan(-1);

    // Check for identity info
    const identityIndex = symbolInfo.findIndex((item: any) =>
      Array.isArray(item) && item[0] === "identity"
    );
    expect(identityIndex).toBeGreaterThan(-1);
    const identity = symbolInfo[identityIndex];
    // Check that it has the right kind
    const kindIndex = identity.indexOf(":kind");
    expect(kindIndex).toBeGreaterThan(-1);
    expect(identity[kindIndex + 1]).toBe("class");
    // Check flags array contains :class
    const flagsIndex = identity.indexOf(":flags");
    expect(flagsIndex).toBeGreaterThan(-1);
    const flags = identity[flagsIndex + 1];
    expect(flags).toContain(":class");

    // Check for location info
    const locationIndex = symbolInfo.findIndex((item: any) =>
      Array.isArray(item) && item[0] === "location"
    );
    expect(locationIndex).toBeGreaterThan(-1);

    // Check for type info
    const typeIndex = symbolInfo.findIndex((item: any) =>
      Array.isArray(item) && item[0] === "type"
    );
    expect(typeIndex).toBeGreaterThan(-1);

    // Check for hierarchy info
    const hierarchyIndex = symbolInfo.findIndex((item: any) =>
      Array.isArray(item) && item[0] === "hierarchy"
    );
    expect(hierarchyIndex).toBeGreaterThan(-1);
    const hierarchy = symbolInfo[hierarchyIndex];
    // Should show it extends BaseRepository
    const baseIndex = hierarchy.indexOf(":base");
    expect(baseIndex).toBeGreaterThan(-1);

    // Check for members info
    const membersIndex = symbolInfo.findIndex((item: any) =>
      Array.isArray(item) && item[0] === "members"
    );
    expect(membersIndex).toBeGreaterThan(-1);
  });

  it("should handle multiple queries in one call", async () => {
    const testFile = join(testDir, "multi.ts");

    writeFileSync(testFile, `
interface Config {
  apiUrl: string;
  timeout: number;
}

class Service {
  constructor(private config: Config) {}
  
  async fetchData(): Promise<any> {
    // Implementation
    return {};
  }
}

const defaultConfig: Config = {
  apiUrl: "https://api.example.com",
  timeout: 5000
};

const service = new Service(defaultConfig);
`);

    // Test multiple queries
    const result = await service.analyze(testFile, [
      {
        at: "interface Config###",
        want: {
          identity: true,
          members: true
        }
      },
      {
        at: "fetchData###()",
        want: {
          identity: true,
          signature: true,
          type: true
        }
      }
    ]);

    const sexpr = toSExpr(result);
    expect(sexpr[0]).toBe("analysis");

    // Should have two symbol results
    expect(sexpr.length).toBe(3); // "analysis" + 2 symbols

    // First should be Config
    const configInfo = sexpr[1];
    expect(configInfo[1]).toBe("Config");

    // Second should be fetchData
    const fetchInfo = sexpr[2];
    expect(fetchInfo[1]).toBe("fetchData");

    // Check fetchData has signature info
    const sigIndex = fetchInfo.findIndex((item: any) =>
      Array.isArray(item) && item[0] === "signatures"
    );
    expect(sigIndex).toBeGreaterThan(-1);
  });

  it("should handle usage and impact bundles", async () => {
    const testFile = join(testDir, "impact.ts");
    const usageFile = join(testDir, "usage.ts");

    writeFileSync(testFile, `
export interface DataProvider {
  getData(): string[];
}

export class DefaultProvider implements DataProvider {
  getData(): string[] {
    return ["a", "b", "c"];
  }
}
`);

    writeFileSync(usageFile, `
import { DataProvider, DefaultProvider } from './impact';

class Consumer {
  constructor(private provider: DataProvider) {}
  
  process(): void {
    const data = this.provider.getData();
    console.log(data);
  }
}

const provider = new DefaultProvider();
const consumer = new Consumer(provider);
consumer.process();
`);

    const result = await service.analyze(testFile, [
      {
        at: "interface DataProvider###",
        want: {
          usage: { limit: 10, includeTests: false },
          impact: { depth: 2, includeTests: false }
        }
      }
    ]);

    const sexpr = toSExpr(result);
    const symbolInfo = sexpr[1];

    // Check for usage info
    const usageIndex = symbolInfo.findIndex((item: any) =>
      Array.isArray(item) && item[0] === "usage"
    );
    expect(usageIndex).toBeGreaterThan(-1);
    const usage = symbolInfo[usageIndex];
    const countIndex = usage.indexOf(":count");
    expect(countIndex).toBeGreaterThan(-1);
    expect(usage[countIndex + 1]).toBeGreaterThan(0);

    // Check for impact info
    const impactIndex = symbolInfo.findIndex((item: any) =>
      Array.isArray(item) && item[0] === "impact"
    );
    expect(impactIndex).toBeGreaterThan(-1);
  });
});
