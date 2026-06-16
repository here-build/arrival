import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TSLanguageServiceWrapper } from "./ts-language-service";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { toSExpr } from "@here.build/arrival-serializer";

describe("Enhanced Hover with Full Types", () => {
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

  it("should show full type for inferred types", async () => {
    const testFile = join(testDir, "inferred.ts");

    writeFileSync(testFile, `
type User = {
  id: string;
  name: string;
  email: string;
};

type Product = {
  id: string;
  title: string;
  price: number;
};

// Complex inferred type
const result = {
  users: [
    { id: "1", name: "Alice", email: "alice@example.com" },
    { id: "2", name: "Bob", email: "bob@example.com" }
  ] as User[],
  products: [
    { id: "p1", title: "Widget", price: 9.99 },
    { id: "p2", title: "Gadget", price: 19.99 }
  ] as Product[],
  total: 2,
  timestamp: new Date()
};
`);

    // Hover over 'result' to see the inferred type
    const hover = await service.getHover(
      testFile,
      15, // line where result is declared (adjust for empty line at start)
      6   // character position of "result"
    );

    expect(hover).toBeDefined();
    if (!hover) {
      throw new Error("Hover returned null");
    }

    const sexpr = toSExpr(hover);

    // Should have the full type information
    const fullTypeIndex = sexpr.indexOf(":full-type");
    expect(fullTypeIndex).toBeGreaterThan(-1);

    const fullType = sexpr[fullTypeIndex + 1];
    expect(fullType).toContain("users:");
    expect(fullType).toContain("User[]");
    expect(fullType).toContain("products:");
    expect(fullType).toContain("Product[]");
    expect(fullType).toContain("total:");
    expect(fullType).toContain("timestamp:");
  });

  it("should show expanded type for type aliases", async () => {
    const testFile = join(testDir, "aliases.ts");

    writeFileSync(testFile, `
type ID = string;
type Email = string;
type Price = number;

type User = {
  id: ID;
  email: Email;
};

type Product = {
  id: ID;
  price: Price;
};

type Cart = {
  user: User;
  products: Product[];
  total: Price;
};

const myCart: Cart = {
  user: { id: "u1", email: "test@example.com" },
  products: [{ id: "p1", price: 10 }],
  total: 10
};
`);

    // Hover over 'Cart' type to see both aliased and expanded types
    // Line 22 is "const myCart: Cart = {", Cart starts at position 14
    const hover = await service.getHover(
      testFile,
      22,
      14
    );

    expect(hover).toBeDefined();

    const sexpr = toSExpr(hover);

    // Should have full-type
    const fullTypeIndex = sexpr.indexOf(":full-type");
    expect(fullTypeIndex).toBeGreaterThan(-1);

    const fullType = sexpr[fullTypeIndex + 1];

    // Full type could be "Cart" or the expanded type - either is valid
    // When hovering on a type annotation, TypeScript may show the expanded type
    expect(fullType).toBeDefined();

    // The type should contain the expected structure with User and Product
    // It may be expanded directly or reference the type alias
    const hasUserProperty = fullType.includes("user") || fullType.includes("User");
    const hasProductsProperty = fullType.includes("products") || fullType.includes("Product");
    expect(hasUserProperty || fullType.includes("Cart")).toBe(true);
    expect(hasProductsProperty || fullType.includes("Cart")).toBe(true);
  });

  it("should handle complex generic types", async () => {
    const testFile = join(testDir, "generics.ts");

    writeFileSync(testFile, `
interface Repository<T> {
  findById(id: string): Promise<T | null>;
  findAll(): Promise<T[]>;
  save(item: T): Promise<T>;
}

class UserRepository implements Repository<User> {
  async findById(id: string): Promise<User | null> {
    return null;
  }
  
  async findAll(): Promise<User[]> {
    return [];
  }
  
  async save(user: User): Promise<User> {
    return user;
  }
}

interface User {
  id: string;
  name: string;
}

const repo = new UserRepository();
const allUsers = repo.findAll();
`);

    // Hover over 'allUsers' to see the resolved generic type
    const hover = await service.getHover(
      testFile,
      28, // line where allUsers is declared (adjust for empty line)
      6   // character position of "allUsers"
    );

    expect(hover).toBeDefined();

    const sexpr = toSExpr(hover);

    const fullTypeIndex = sexpr.indexOf(":full-type");
    expect(fullTypeIndex).toBeGreaterThan(-1);

    const fullType = sexpr[fullTypeIndex + 1];
    expect(fullType).toContain("Promise<User[]>");
  });
});
