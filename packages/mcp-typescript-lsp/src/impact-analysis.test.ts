import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TSLanguageServiceWrapper } from "./ts-language-service";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { toSExpr } from "@here.build/arrival";

describe("Impact Analysis", () => {
  let service: TSLanguageServiceWrapper;
  let testDir: string;

  beforeEach(() => {
    service = new TSLanguageServiceWrapper();
    // Ensure clean cache state
    service.invalidateCache();
    testDir = join(tmpdir(), `ts-lsp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });

    // Create a tsconfig.json so TypeScript can find all files
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

  it("should analyze impact of interface changes", async () => {
    // Create test files
    const interfaceFile = join(testDir, "types.ts");
    const componentFile = join(testDir, "component.ts");
    const utilFile = join(testDir, "utils.ts");
    const testFile = join(testDir, "component.test.ts");

    writeFileSync(interfaceFile, `
export interface User {
  id: string;
  name: string;
  email: string;
}

export interface Product {
  id: string;
  title: string;
}
`);

    writeFileSync(componentFile, `
import { User } from './types';

export class UserComponent {
  constructor(private user: User) {}
  
  render(): string {
    return \`<div>\${this.user.name}</div>\`;
  }
  
  updateUser(user: User): void {
    this.user = user;
  }
}

export function createUserCard(user: User): string {
  return \`<div class="card">\${user.name} - \${user.email}</div>\`;
}
`);

    writeFileSync(utilFile, `
import { User } from './types';

export function validateUser(user: User): boolean {
  return user.email.includes('@');
}

export function formatUserName(user: User): string {
  return user.name.toUpperCase();
}
`);

    writeFileSync(testFile, `
import { User } from './types';
import { UserComponent } from './component';

describe('UserComponent', () => {
  it('should render user', () => {
    const user: User = { id: '1', name: 'Test', email: 'test@example.com' };
    const component = new UserComponent(user);
    expect(component.render()).toContain('Test');
  });
});
`);

    // Analyze impact
    const result = await service.analyzeImpact(
      "User",
      interfaceFile,
      2,
      true,
      "file"
    );

    // Convert s-expression to actual array
    const sexpr = toSExpr(result);

    // Verify s-expression structure
    expect(sexpr[0]).toBe("impact-analysis");
    expect(sexpr[1]).toBe("User");

    // Should find impacts in all files
    const impactedFiles = (sexpr as any[]).slice(2);
    expect(impactedFiles.length).toBeGreaterThanOrEqual(2); // component and utils

    // Check that we found the component file
    const componentImpact = impactedFiles.find(
      (impact: any) => impact[0] === "file" && impact[1].includes("component.ts")
    );
    expect(componentImpact).toBeDefined();

    // Should have found UserComponent class and createUserCard function
    const componentNodes = componentImpact.slice(2);
    const hasUserComponent = componentNodes.some(
      (node: any) => node[0] === "class" && node[1] === "UserComponent"
    );
    const hasCreateUserCard = componentNodes.some(
      (node: any) => node[0] === "function" && node[1] === "createUserCard"
    );

    expect(hasUserComponent).toBe(true);
    expect(hasCreateUserCard).toBe(true);
  });

  it("should exclude test files when requested", async () => {
    const interfaceFile = join(testDir, "types.ts");
    const componentFile = join(testDir, "component.ts");
    const testFile = join(testDir, "component.test.ts");

    writeFileSync(interfaceFile, `
export interface Config {
  apiUrl: string;
  timeout: number;
}
`);

    writeFileSync(componentFile, `
import { Config } from './types';

export function initializeApp(config: Config): void {
  console.log('Initializing with', config.apiUrl);
}
`);

    writeFileSync(testFile, `
import { Config } from './types';

describe('Config', () => {
  it('should have apiUrl', () => {
    const config: Config = { apiUrl: 'http://test', timeout: 5000 };
    expect(config.apiUrl).toBe('http://test');
  });
});
`);

    // Analyze without tests
    const result = await service.analyzeImpact(
      "Config",
      interfaceFile,
      1,
      false, // exclude tests
      "file"
    );

    const sexpr = toSExpr(result);
    const impactedFiles = (sexpr as any[]).slice(2);

    // Should not include test file
    const hasTestFile = impactedFiles.some(
      (impact: any) => impact[0] === "file" && impact[1].includes(".test.ts")
    );

    expect(hasTestFile).toBe(false);

    // Should still include component file
    const hasComponentFile = impactedFiles.some(
      (impact: any) => impact[0] === "file" && impact[1].includes("component.ts")
    );

    expect(hasComponentFile).toBe(true);
  });

  it("should create nested impact tree", async () => {
    // Create test files with deeper dependencies
    const interfaceFile = join(testDir, "types.ts");
    const serviceFile = join(testDir, "service.ts");
    const controllerFile = join(testDir, "controller.ts");
    const routerFile = join(testDir, "router.ts");

    writeFileSync(interfaceFile, `
export interface User {
  id: string;
  name: string;
  email: string;
}
`);

    writeFileSync(serviceFile, `
import { User } from './types';

export class UserService {
  getUser(id: string): User {
    return { id, name: 'Test', email: 'test@example.com' };
  }
  
  updateUser(user: User): void {
    console.log('Updating user', user);
  }
}
`);

    writeFileSync(controllerFile, `
import { User } from './types';
import { UserService } from './service';

export class UserController {
  private service = new UserService();
  
  handleGetUser(id: string): User {
    return this.service.getUser(id);
  }
  
  handleUpdateUser(user: User): void {
    this.service.updateUser(user);
  }
}
`);

    writeFileSync(routerFile, `
import { UserController } from './controller';

export function setupRoutes() {
  const controller = new UserController();
  
  // Routes would be set up here
  return controller;
}
`);

    // Analyze with nested grouping
    const result = await service.analyzeImpact(
      "User",
      interfaceFile,
      3, // deeper depth to see the chain
      true,
      "nested"
    );

    const sexpr = toSExpr(result);

    // Verify nested structure
    expect(sexpr[0]).toBe("impact-analysis");
    expect(sexpr[1]).toBe("User");

    // Find method impacts that have nested structure
    const methodImpacts = sexpr.slice(2).filter(
      (impact: any) => impact[0] === "impacted" && impact.length > 8
    );
    expect(methodImpacts.length).toBeGreaterThan(0);

    // Check that getUser method has nested impacts
    const getUserImpact = methodImpacts.find(
      (impact: any) => impact[1] === "getUser"
    );
    expect(getUserImpact).toBeDefined();

    // Verify the nested structure shows handleGetUser
    const nestedHandleGet = getUserImpact.slice(8).find(
      (nested: any) => nested === "getUser" || (nested[0] === "impacted" && nested[1] === "handleGetUser")
    );
    expect(nestedHandleGet).toBeDefined();

    // Also check imports are tracked
    const imports = sexpr.slice(2).filter(
      (impact: any) => impact[0] === "imports"
    );
    expect(imports.length).toBeGreaterThan(0);
  });
});
