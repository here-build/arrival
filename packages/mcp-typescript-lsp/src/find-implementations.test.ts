import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TSLanguageServiceWrapper } from "./ts-language-service";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { toSExpr } from "@inhuman.tools/arrival-serializer";

describe("Find Implementations", () => {
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

  it("should find implementations of interfaces", async () => {
    const interfaceFile = join(testDir, "repository.ts");
    const mongoFile = join(testDir, "mongo-repository.ts");
    const postgresFile = join(testDir, "postgres-repository.ts");

    writeFileSync(interfaceFile, `
export interface UserRepository {
  findById(id: string): Promise<User | null>;
  save(user: User): Promise<void>;
  delete(id: string): Promise<boolean>;
}

export interface User {
  id: string;
  name: string;
  email: string;
}
`);

    writeFileSync(mongoFile, `
import { UserRepository, User } from './repository';

export class MongoUserRepository implements UserRepository {
  async findById(id: string): Promise<User | null> {
    // MongoDB implementation
    return null;
  }
  
  async save(user: User): Promise<void> {
    // MongoDB implementation
  }
  
  async delete(id: string): Promise<boolean> {
    // MongoDB implementation
    return true;
  }
}
`);

    writeFileSync(postgresFile, `
import { UserRepository, User } from './repository';

export class PostgresUserRepository implements UserRepository {
  async findById(id: string): Promise<User | null> {
    // PostgreSQL implementation
    return null;
  }
  
  async save(user: User): Promise<void> {
    // PostgreSQL implementation
  }
  
  async delete(id: string): Promise<boolean> {
    // PostgreSQL implementation
    return true;
  }
}
`);

    // Find implementations of UserRepository interface
    const result = await service.findImplementations(
      interfaceFile,
      2, // line where interface is declared
      17 // character position of "UserRepository"
    );

    const sexpr = toSExpr(result);

    expect(sexpr[0]).toBe("implementations");
    // Symbol name should contain "Repository" (might be UserRepository or just Repository depending on position)
    expect(sexpr[1]).toContain("Repository");

    // Should find both implementations
    const implementations = sexpr.slice(2);
    expect(implementations.length).toBeGreaterThanOrEqual(2);

    // Check MongoDB implementation
    const mongoImpl = implementations.find(
      (impl: any) => impl[1] === "MongoUserRepository"
    );
    expect(mongoImpl).toBeDefined();
    expect(mongoImpl[0]).toBe("implementation");
    expect(mongoImpl[3]).toContain("mongo-repository.ts");

    // Check PostgreSQL implementation
    const pgImpl = implementations.find(
      (impl: any) => impl[1] === "PostgresUserRepository"
    );
    expect(pgImpl).toBeDefined();
    expect(pgImpl[0]).toBe("implementation");
    expect(pgImpl[3]).toContain("postgres-repository.ts");
  });

  it("should find subclasses of concrete classes", async () => {
    const baseFile = join(testDir, "base.ts");
    const derivedFile = join(testDir, "derived.ts");

    writeFileSync(baseFile, `
export class Animal {
  name: string;
  
  constructor(name: string) {
    this.name = name;
  }
  
  makeSound(): string {
    return "Some sound";
  }
}
`);

    writeFileSync(derivedFile, `
import { Animal } from './base';

export class Dog extends Animal {
  breed: string;
  
  constructor(name: string, breed: string) {
    super(name);
    this.breed = breed;
  }
  
  makeSound(): string {
    return "Woof!";
  }
}

export class Cat extends Animal {
  color: string;
  
  constructor(name: string, color: string) {
    super(name);
    this.color = color;
  }
  
  makeSound(): string {
    return "Meow!";
  }
}
`);

    // Find subclasses of Animal
    const result = await service.findImplementations(
      baseFile,
      2, // line where class is declared
      13 // character position of "Animal"
    );

    const sexpr = toSExpr(result);

    expect(sexpr[0]).toBe("implementations");
    expect(sexpr[1]).toBe("Animal");

    // Should find both subclasses
    const subclasses = sexpr.slice(2);
    expect(subclasses.length).toBe(2);

    // Check Dog subclass
    const dogClass = subclasses.find(
      (impl: any) => impl[1] === "Dog"
    );
    expect(dogClass).toBeDefined();
    expect(dogClass[0]).toBe("subclass");

    // Check Cat subclass
    const catClass = subclasses.find(
      (impl: any) => impl[1] === "Cat"
    );
    expect(catClass).toBeDefined();
    expect(catClass[0]).toBe("subclass");
  });

  it("should handle abstract classes", async () => {
    const abstractFile = join(testDir, "abstract.ts");
    const concreteFile = join(testDir, "concrete.ts");

    writeFileSync(abstractFile, `
export abstract class Shape {
  abstract area(): number;
  abstract perimeter(): number;
  
  describe(): string {
    return \`Area: \${this.area()}, Perimeter: \${this.perimeter()}\`;
  }
}
`);

    writeFileSync(concreteFile, `
import { Shape } from './abstract';

export class Circle extends Shape {
  constructor(private radius: number) {
    super();
  }
  
  area(): number {
    return Math.PI * this.radius * this.radius;
  }
  
  perimeter(): number {
    return 2 * Math.PI * this.radius;
  }
}

export abstract class Polygon extends Shape {
  constructor(protected sides: number) {
    super();
  }
}

export class Square extends Polygon {
  constructor(private side: number) {
    super(4);
  }
  
  area(): number {
    return this.side * this.side;
  }
  
  perimeter(): number {
    return 4 * this.side;
  }
}
`);

    // Find implementations of abstract Shape class
    const result = await service.findImplementations(
      abstractFile,
      2, // line where abstract class is declared
      22 // character position of "Shape"
    );

    const sexpr = toSExpr(result);

    expect(sexpr[0]).toBe("implementations");
    expect(sexpr[1]).toBe("Shape");

    const implementations = sexpr.slice(2);

    // Should find Circle as concrete implementation
    const circleImpl = implementations.find(
      (impl: any) => impl[1] === "Circle"
    );
    expect(circleImpl).toBeDefined();
    expect(circleImpl[0]).toBe("implementation");

    // Should find Polygon as abstract implementation
    const polygonImpl = implementations.find(
      (impl: any) => impl[1] === "Polygon"
    );
    expect(polygonImpl).toBeDefined();
    expect(polygonImpl[0]).toBe("abstract-implementation");

    // Should find Square as concrete implementation
    const squareImpl = implementations.find(
      (impl: any) => impl[1] === "Square"
    );
    expect(squareImpl).toBeDefined();
    expect(squareImpl[0]).toBe("implementation");
  });
});
