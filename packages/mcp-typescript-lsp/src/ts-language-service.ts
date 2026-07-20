/**
 * TypeScript semantic queries over a project's source, serialized to s-expressions.
 *
 * `TSLanguageServiceWrapper` drives the TypeScript compiler's `LanguageService` — the same
 * engine an IDE uses — to answer questions text search cannot: inferred types, cross-file
 * references, interface implementations, inheritance trees, change impact. Every public method
 * returns either a plain DTO (see types.ts) or a `SExprDefinition`; the DTO shapes serialize
 * themselves through the `*Impl` classes at the bottom of this file (see SEXPR OUTPUT).
 *
 * SERVICE CACHE. One `ts.LanguageService` per project root, keyed in `services`/`hosts` by the
 * nearest ancestor directory holding a tsconfig.json (`findProjectRoot`; falls back to the
 * file's own directory when none is found). Services are expensive to build, so they are reused
 * across calls and rebuilt only on staleness.
 *
 * STALENESS. The host detects changed files itself rather than trusting a watcher, because this
 * tool runs out-of-band against files edited by other processes. `getScriptSnapshot` diffs
 * content and bumps the file version; `getScriptVersion` additionally stat()s `.d.ts`
 * dependencies by mtime, because TS re-reads a snapshot only when the version changes and would
 * otherwise never notice a rebuilt declaration file. A content change to a previously-cached
 * file sets `host.needsRefresh`, and `getOrCreateService` drops and rebuilds the service on the
 * next call — the host cannot call back into the wrapper, so it signals through the flag.
 *
 * POSITION MODEL. Positions are 1-based line, 0-based character everywhere they cross this
 * file's surface (matching selector-parser.ts output and the MCP schema). `positionToOffset` /
 * `offsetToPosition` convert against the file's CURRENT disk content, re-read on every call —
 * there is no line-index cache. This reads disk, not the language-service snapshot; the two
 * agree only because callers analyze saved files, never unsaved in-memory edits.
 *
 * DIST→SRC. A definition resolving into a `/dist/**.d.ts` is remapped to its `/src/**.ts(x)`
 * twin when one exists on disk (`tryFindSourceForDist`), and the source is returned FIRST with
 * the declaration second — so "go to definition" through a built dependency lands in editable
 * source, not a generated artifact.
 *
 * SYMBOL RESOLUTION. `analyzeSymbolAt` resolves a cursor to a `ts.Symbol` through ordered
 * fallbacks because the `###` selector marks the position immediately AFTER an identifier: it
 * first probes offset-1 (and up to 3 back at file scope) to land inside the name, then tries
 * symbol-at-node, identifier-node, parent-node, and finally walks ancestors for a named
 * declaration. First strategy to yield a symbol wins; none yielding returns an `unknown` symbol
 * rather than throwing.
 *
 * IMPACT TRAVERSAL. `analyzeImpact` walks the reference graph outward to `depth` levels in one
 * of two shapes chosen by `groupBy`: the flat modes ("file"/"component"/"flat") accumulate into
 * a shared `visited` set and dedup by symbol name (`processReferencesRecursively` →
 * `formatImpactAnalysis`); "nested" builds a dependency tree (`buildNestedImpactTree`) that
 * CLONES `visited` per branch so a symbol reached by two paths appears under both, and emits a
 * `circular-ref` marker instead of recursing when a path revisits a node. Both skip the
 * definition site and, when `includeTests` is false, `*.test.ts` references.
 *
 * SEXPR OUTPUT. Result DTOs serialize via `[Symbol.toSExpr]` on the `*Impl` classes below;
 * `SExprDefinition` is `[SEXPR_TAG, tag, ...rest]`. When one query composes another (hierarchy
 * pulling implementations, impact reusing analyzeImpact), the inner result is re-read
 * POSITIONALLY — `slice(3)` drops `[SEXPR_TAG, tag, name]`, and the tag is checked at index 1.
 * That coupling to the envelope layout is deliberate but unguarded: changing the sexpr envelope
 * shape breaks these splices.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { sexpr, SEXPR_TAG, type SExprDefinition, type SExprSerializable } from "@inhuman.tools/arrival-serializer";
import * as ts from "typescript";

import { parseSelectorWithOccurrence } from "./selector-parser.js";
import type {
  CallHierarchyItem,
  CompletionItem,
  Definition,
  Diagnostic,
  DocumentSymbol,
  HoverInfo,
  Reference,
  TypeHierarchyItem,
} from "./types.js";

interface ImpactNode {
  kind: string;
  name: string;
  line: number;
  character: number;
}

/** Options for the unified `analyze` action's `want` parameter */
interface AnalyzeWant {
  identity?: boolean;
  location?: boolean;
  type?: boolean | { expanded?: boolean; constraints?: boolean };
  signature?: boolean;
  hierarchy?: boolean | { depth?: number; implementations?: boolean };
  members?: boolean;
  usage?: boolean | { limit?: number; includeTests?: boolean };
  impact?: boolean | { depth?: number; includeTests?: boolean };
  diagnostics?: boolean | { severity?: string };
  flow?: boolean;
}

/** A single query in the unified `analyze` action */
interface AnalyzeQuery {
  at: string;
  want: AnalyzeWant;
}

interface ExtendedLanguageServiceHost extends ts.LanguageServiceHost {
  dynamicFiles: Set<string>;
  needsRefresh: boolean;
}

/** Extract the name identifier from a TS declaration node, if it has one. */
function getDeclarationName(node: ts.Node): ts.Identifier | undefined {
  if (
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isModuleDeclaration(node)
  ) {
    return node.name && ts.isIdentifier(node.name) ? node.name : undefined;
  }
  if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
    return node.name;
  }
  return undefined;
}

export class TSLanguageServiceWrapper {
  private readonly services: Map<string, ts.LanguageService> = new Map();
  private readonly hosts: Map<string, ExtendedLanguageServiceHost> = new Map();

  // Add method to invalidate cached services
  invalidateCache(filePath?: string): void {
    if (filePath) {
      const projectRoot = this.findProjectRoot(filePath);
      this.services.delete(projectRoot);
      this.hosts.delete(projectRoot);
    } else {
      // Clear all caches
      this.services.clear();
      this.hosts.clear();
    }
  }

  async getHover(filePath: string, line: number, character: number): Promise<HoverInfo | null> {
    const service = this.getOrCreateService(filePath);
    const offset = this.positionToOffset(filePath, line, character);

    const quickInfo = service.getQuickInfoAtPosition(filePath, offset);
    if (!quickInfo) return null;

    // Get the program and checker for more detailed type info
    const program = service.getProgram();
    let fullType: string | undefined;
    let expandedType: string | undefined;

    if (program) {
      const sourceFile = program.getSourceFile(filePath);
      const checker = program.getTypeChecker();

      if (sourceFile) {
        const node = this.findNodeAtOffset(sourceFile, offset);
        if (node) {
          const type = checker.getTypeAtLocation(node);

          // Get the full type string
          fullType = checker.typeToString(type, node, ts.TypeFormatFlags.InTypeAlias);

          // Get expanded type (with all aliases resolved)
          expandedType = checker.typeToString(
            type,
            node,
            ts.TypeFormatFlags.InTypeAlias |
              ts.TypeFormatFlags.NoTruncation |
              ts.TypeFormatFlags.WriteTypeArgumentsOfSignature,
          );

          // If they're the same, don't include expanded
          if (fullType === expandedType) {
            expandedType = undefined;
          }
        }
      }
    }

    // Enhanced hover for class/interface/type alias declarations
    let heritage: string | undefined;
    let constructorSig: string | undefined;
    let ownMembers: Array<{ name: string; type: string; memberKind: "field" | "method" }> | undefined;
    let totalMembers: number | undefined;

    if (program) {
      const sourceFile = program.getSourceFile(filePath);
      const checker = program.getTypeChecker();

      if (sourceFile) {
        const node = this.findNodeAtOffset(sourceFile, offset);
        if (node) {
          const declNode = this.findDeclarationNode(node);

          if (declNode && (ts.isClassDeclaration(declNode) || ts.isInterfaceDeclaration(declNode))) {
            // Heritage clause
            if (declNode.heritageClauses) {
              heritage = declNode.heritageClauses
                .map((c) => {
                  const keyword = c.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";
                  const types = c.types.map((t) => t.getText(sourceFile)).join(", ");
                  return `${keyword} ${types}`;
                })
                .join(" ");
            }

            // Constructor (for classes)
            if (ts.isClassDeclaration(declNode)) {
              for (const member of declNode.members) {
                if (ts.isConstructorDeclaration(member)) {
                  const params = member.parameters.map((p) => p.getText(sourceFile)).join(", ");
                  constructorSig = `(${params})`;
                  break;
                }
              }
            }

            // Own members (field vs method)
            const type = checker.getTypeAtLocation(declNode);
            const allProps = type.getProperties();
            totalMembers = allProps.length;

            // Get own declarations (not inherited)
            const ownDecls = declNode.members as ts.NodeArray<ts.ClassElement | ts.TypeElement>;
            const members: Array<{ name: string; type: string; memberKind: "field" | "method" }> = [];

            for (const member of ownDecls) {
              if (members.length >= 15) break;
              if (ts.isConstructorDeclaration(member)) continue;

              const memberName = member.name ? member.name.getText(sourceFile) : undefined;
              if (!memberName) continue;

              const isMethod = ts.isMethodDeclaration(member) || ts.isMethodSignature(member);
              const memberSymbol = checker.getSymbolAtLocation(member.name!);
              let memberType = "unknown";
              if (memberSymbol) {
                const mType = checker.getTypeOfSymbolAtLocation(memberSymbol, member);
                memberType = checker.typeToString(mType);
              }

              members.push({
                name: memberName,
                type: memberType,
                memberKind: isMethod ? "method" : "field",
              });
            }

            if (members.length > 0) {
              ownMembers = members;
            }
          } else if (declNode && ts.isTypeAliasDeclaration(declNode)) {
            // For type aliases: show the full definition
            fullType = declNode.type.getText(sourceFile);
          }
        }
      }
    }

    return new HoverInfoImpl(
      quickInfo.displayParts?.map((p) => p.text).join("") || "",
      quickInfo.documentation?.map((d) => d.text).join("\n"),
      quickInfo.tags?.map((tag) => ({
        name: tag.name,
        text: tag.text?.map((p) => p.text).join("") || "",
      })),
      fullType,
      expandedType,
      heritage,
      constructorSig,
      ownMembers,
      totalMembers,
    );
  }

  private findProjectRoot(filePath: string): string {
    let dir = path.dirname(filePath);

    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, "tsconfig.json"))) {
        return dir;
      }
      dir = path.dirname(dir);
    }

    // If no tsconfig found, use the file's directory
    return path.dirname(filePath);
  }

  async getDefinition(filePath: string, line: number, character: number): Promise<Definition[]> {
    const service = this.getOrCreateService(filePath);
    const offset = this.positionToOffset(filePath, line, character);

    const definitions = service.getDefinitionAtPosition(filePath, offset);
    if (!definitions) return [];

    const results: Definition[] = [];

    for (const def of definitions) {
      const defFile = def.fileName;

      // Check if this definition points to a /dist/ file — try to find source
      if (defFile.includes("/dist/")) {
        const sourceFile = this.tryFindSourceForDist(defFile);
        if (sourceFile) {
          // Source first (primary), then declaration
          results.push(
            new DefinitionImpl(
              sourceFile,
              this.findSymbolInFile(sourceFile, def.name, service) ?? this.offsetToPosition(sourceFile, 0),
              def.kind,
              def.name,
              true,
            ),
          );
          results.push(
            new DefinitionImpl(defFile, this.offsetToPosition(defFile, def.textSpan.start), def.kind, def.name, false),
          );
          continue;
        }
      }

      results.push(
        new DefinitionImpl(defFile, this.offsetToPosition(defFile, def.textSpan.start), def.kind, def.name, true),
      );
    }

    return results;
  }

  private positionToOffset(filePath: string, line: number, character: number): number {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");

    let offset = 0;
    for (let i = 0; i < line - 1 && i < lines.length; i++) {
      offset += lines[i].length + 1; // +1 for newline
    }

    return offset + character;
  }

  async getDocumentSymbols(
    filePath: string,
    scope: "exports" | "top-level" | "outline" | "all" = "outline",
  ): Promise<DocumentSymbol[]> {
    const service = this.getOrCreateService(filePath);

    if (scope === "exports") {
      return this.getExportedSymbols(filePath, service);
    }

    const nav = service.getNavigationTree(filePath);
    const symbols: DocumentSymbol[] = [];

    // Kinds that represent class-like containers whose members we show in "outline" mode
    const containerKinds = new Set([
      "class",
      "interface",
      "enum",
      "type",
      ts.ScriptElementKind.classElement,
      ts.ScriptElementKind.interfaceElement,
      ts.ScriptElementKind.enumElement,
    ]);

    // The navigation tree root is either "<global>" (scripts) or the module name (ES modules).
    // In both cases, treat it as a transparent container — its children are the top-level declarations.
    const isModuleRoot = (item: ts.NavigationTree, depth: number) =>
      depth === 0 && (item.text === "<global>" || item.kind === ts.ScriptElementKind.moduleElement);

    type ParentInfo = { name: string; kind: string } | undefined;

    const processNavTree = (item: ts.NavigationTree, parent?: ParentInfo, depth: number = 0) => {
      if (isModuleRoot(item, depth)) {
        // Skip the module root itself, process children as top-level (depth 0)
        if (item.childItems) {
          for (const child of item.childItems) processNavTree(child, undefined, 0);
        }
        return;
      }

      if (item.text) {
        const isTopLevel = depth === 0;
        const isContainerMember = depth === 1 && parent != null && containerKinds.has(parent.kind);

        const include =
          scope === "all" ||
          (scope === "top-level" && isTopLevel) ||
          (scope === "outline" && (isTopLevel || isContainerMember));

        if (include) {
          symbols.push(
            new DocumentSymbolImpl(
              item.text,
              item.kind,
              this.offsetToPosition(filePath, item.spans[0].start),
              isTopLevel ? undefined : parent?.name,
            ),
          );
        }

        // Recurse into children
        if (item.childItems) {
          const nextParent: ParentInfo = isTopLevel ? { name: item.text, kind: item.kind } : parent;
          for (const child of item.childItems) processNavTree(child, nextParent, depth + 1);
        }
      } else if (item.childItems) {
        for (const child of item.childItems) processNavTree(child, parent, depth);
      }
    };

    processNavTree(nav);
    return symbols;
  }

  async searchSymbols(projectRoot: string, query: string, kind?: string): Promise<DocumentSymbol[]> {
    const service = this.getOrCreateService(projectRoot);
    const host = this.hosts.get(projectRoot);
    if (!host) return [];

    const program = service.getProgram();
    const checker = program?.getTypeChecker();

    const results: DocumentSymbol[] = [];
    const files = host.getScriptFileNames();

    for (const file of files) {
      // Skip stdlib, node_modules, and .d.ts declaration files
      if (file.includes("node_modules") || file.endsWith(".d.ts")) continue;

      const symbols = await this.getDocumentSymbols(file);
      const filtered = symbols.filter((sym) => {
        const nameMatch = sym.name.toLowerCase().includes(query.toLowerCase());
        const kindMatch = !kind || sym.kind === kind;
        return nameMatch && kindMatch;
      });

      // Enrich with descriptions and file paths
      for (const sym of filtered) {
        sym.file = file;
        if (checker && program) {
          sym.description = this.getSymbolDescription(file, sym, program, checker);
        }
      }

      results.push(...filtered);
    }

    return results.slice(0, 100);
  }

  async analyzeImpact(
    target: string,
    filePath?: string,
    depth: number = 2,
    includeTests: boolean = true,
    groupBy: "file" | "component" | "flat" | "nested" = "file",
  ): Promise<SExprDefinition> {
    // First, find the target symbol
    let targetSymbol: ts.Symbol | undefined;
    let targetFile: string | undefined;

    if (filePath) {
      // If file is provided, search in that file first
      const service = this.getOrCreateService(filePath);
      const program = service.getProgram();
      if (!program) throw new Error("Could not get program");

      const sourceFile = program.getSourceFile(filePath);
      if (!sourceFile) throw new Error(`Could not find source file: ${filePath}`);

      const checker = program.getTypeChecker();

      // Find the symbol in this file
      const visitor = (node: ts.Node): void => {
        if (ts.isInterfaceDeclaration(node) && node.name?.text === target) {
          targetSymbol = checker.getSymbolAtLocation(node.name);
          targetFile = filePath;
        } else if (ts.isTypeAliasDeclaration(node) && node.name?.text === target) {
          targetSymbol = checker.getSymbolAtLocation(node.name);
          targetFile = filePath;
        } else if (ts.isClassDeclaration(node) && node.name?.text === target) {
          targetSymbol = checker.getSymbolAtLocation(node.name);
          targetFile = filePath;
        } else if (ts.isFunctionDeclaration(node) && node.name?.text === target) {
          targetSymbol = checker.getSymbolAtLocation(node.name);
          targetFile = filePath;
        } else if (
          ts.isMethodDeclaration(node) &&
          node.name &&
          ts.isIdentifier(node.name) &&
          node.name.text === target
        ) {
          targetSymbol = checker.getSymbolAtLocation(node.name);
          targetFile = filePath;
        } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === target) {
          targetSymbol = checker.getSymbolAtLocation(node.name);
          targetFile = filePath;
        }
        if (!targetSymbol) {
          ts.forEachChild(node, visitor);
        }
      };

      visitor(sourceFile);
    }

    if (!targetSymbol || !targetFile) {
      // Search across all files
      // This is a simplified version - in real implementation would be smarter
      throw new Error(`Could not find symbol: ${target}`);
    }

    // Now analyze impact
    const service = this.getOrCreateService(targetFile);
    const symbolDeclarations = targetSymbol.getDeclarations();
    if (!symbolDeclarations || symbolDeclarations.length === 0) {
      return this.formatImpactAnalysis(new Map(), target, groupBy);
    }

    const firstDecl = symbolDeclarations[0];
    const startPos = firstDecl.getStart();
    const { line: startLine, character: startChar } = this.offsetToPosition(targetFile, startPos);

    // Get initial references
    const references = await this.getReferences(targetFile, startLine, startChar);

    if (groupBy === "nested") {
      // Build nested impact tree
      const impactTree = await this.buildNestedImpactTree(
        target,
        targetFile,
        startLine,
        startChar,
        references,
        depth,
        includeTests,
        new Set<string>(),
        1,
      );
      return impactTree;
    } else {
      // Original flat analysis
      const impactMap = new Map<string, Set<ImpactNode>>();
      const visited = new Set<string>();

      await this.processReferencesRecursively(references, impactMap, visited, depth, includeTests, 1);

      return this.formatImpactAnalysis(impactMap, target, groupBy);
    }
  }

  async findImplementations(filePath: string, line: number, character: number): Promise<SExprDefinition> {
    const service = this.getOrCreateService(filePath);
    const offset = this.positionToOffset(filePath, line, character);

    const program = service.getProgram();
    if (!program) throw new Error("Could not get program");

    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) throw new Error(`Could not find source file: ${filePath}`);

    const checker = program.getTypeChecker();

    // Find the node at position
    const node = this.findNodeAtOffset(sourceFile, offset);
    if (!node) {
      return sexpr("implementations", "unknown");
    }

    // Get the symbol at this location
    const symbol = checker.getSymbolAtLocation(node);
    if (!symbol) {
      return sexpr("implementations", "unknown");
    }

    const symbolName = symbol.getName();
    const implementations: SExprDefinition[] = [];

    // Check if this is an interface or abstract class
    const declarations = symbol.getDeclarations();
    if (!declarations || declarations.length === 0) {
      return sexpr("implementations", symbolName);
    }

    const firstDecl = declarations[0];
    const isInterface = ts.isInterfaceDeclaration(firstDecl);
    const isAbstractClass =
      ts.isClassDeclaration(firstDecl) && firstDecl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword);

    if (!isInterface && !isAbstractClass) {
      // For concrete classes, find subclasses
      const allSourceFiles = program.getSourceFiles();

      for (const sf of allSourceFiles) {
        if (sf.fileName.includes("node_modules")) continue;

        const visitor = (node: ts.Node): void => {
          if (ts.isClassDeclaration(node) && node.heritageClauses) {
            for (const clause of node.heritageClauses) {
              if (clause.token === ts.SyntaxKind.ExtendsKeyword) {
                for (const typeNode of clause.types) {
                  const type = checker.getTypeAtLocation(typeNode);
                  const typeSymbol = type.getSymbol();

                  if (typeSymbol === symbol) {
                    const className = node.name?.text || "Anonymous";
                    const pos = this.offsetToPosition(sf.fileName, node.name?.getStart() || node.getStart());
                    implementations.push(
                      sexpr("subclass", className, ":file", sf.fileName, ":line", pos.line, ":char", pos.character),
                    );
                  }
                }
              }
            }
          }
          ts.forEachChild(node, visitor);
        };

        visitor(sf);
      }
    } else {
      // Find implementations of interface or abstract class
      const allSourceFiles = program.getSourceFiles();

      // Also find indirect implementations
      const findAllImplementations = (targetSymbol: ts.Symbol, processed: Set<ts.Symbol> = new Set()) => {
        if (processed.has(targetSymbol)) return;
        processed.add(targetSymbol);

        for (const sf of allSourceFiles) {
          if (sf.fileName.includes("node_modules")) continue;

          const visitor = (node: ts.Node): void => {
            if (ts.isClassDeclaration(node) && node.heritageClauses) {
              for (const clause of node.heritageClauses) {
                for (const typeNode of clause.types) {
                  const type = checker.getTypeAtLocation(typeNode);
                  const typeSymbol = type.getSymbol();

                  if (typeSymbol === targetSymbol) {
                    const className = node.name?.text || "Anonymous";
                    const pos = this.offsetToPosition(sf.fileName, node.name?.getStart() || node.getStart());

                    // Check if this is a concrete implementation
                    const isAbstract = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword);

                    implementations.push(
                      sexpr(
                        isAbstract ? "abstract-implementation" : "implementation",
                        className,
                        ":file",
                        sf.fileName,
                        ":line",
                        pos.line,
                        ":char",
                        pos.character,
                      ),
                    );

                    // If this is an abstract implementation, also find its implementations
                    if (isAbstract && node.name) {
                      const childSymbol = checker.getSymbolAtLocation(node.name);
                      if (childSymbol) {
                        findAllImplementations(childSymbol, processed);
                      }
                    }
                  }
                }
              }
            }
            ts.forEachChild(node, visitor);
          };

          visitor(sf);
        }
      };

      findAllImplementations(symbol);
    }

    return sexpr("implementations", symbolName, ...implementations);
  }

  async analyze(filePath: string, queries: AnalyzeQuery[]): Promise<SExprDefinition> {
    const results: SExprSerializable[] = [];

    for (const query of queries) {
      try {
        // Parse position from selector
        let position: { line: number; character: number };
        if (query.at.includes("###")) {
          position = parseSelectorWithOccurrence(filePath, query.at);
        } else if (query.at.includes(":")) {
          const [line, char] = query.at.split(":").map(Number);
          position = { line, character: char };
        } else {
          // Try to find by name
          position = parseSelectorWithOccurrence(filePath, `${query.at}###`);
        }

        const result = await this.analyzeSymbolAt(filePath, position.line, position.character, query.want);

        results.push(result);
      } catch (error) {
        // If we can't parse the position, return an error symbol
        results.push(
          sexpr("symbol", "error", ":at", query.at, ":error", error instanceof Error ? error.message : String(error)),
        );
      }
    }

    return sexpr("analysis", ...results);
  }

  async getReferences(filePath: string, line: number, character: number): Promise<Reference[]> {
    const service = this.getOrCreateService(filePath);
    const offset = this.positionToOffset(filePath, line, character);

    const references = service.getReferencesAtPosition(filePath, offset);
    if (!references) return [];

    // Get the definition to check against
    const definitions = service.getDefinitionAtPosition(filePath, offset);
    const definitionPositions = new Set<string>();
    if (definitions) {
      for (const def of definitions) {
        definitionPositions.add(`${def.fileName}:${def.textSpan.start}`);
      }
    }

    return references.map((ref) => {
      const position = this.offsetToPosition(ref.fileName, ref.textSpan.start);
      const lineText = this.getLineText(ref.fileName, position.line);
      const isDefinition = definitionPositions.has(`${ref.fileName}:${ref.textSpan.start}`);

      return new ReferenceImpl(
        ref.fileName,
        position,
        ref.textSpan.length,
        ref.isWriteAccess || false,
        isDefinition,
        lineText,
      );
    });
  }

  async getCompletions(filePath: string, line: number, character: number): Promise<CompletionItem[]> {
    const service = this.getOrCreateService(filePath);
    const offset = this.positionToOffset(filePath, line, character);

    const completions = service.getCompletionsAtPosition(filePath, offset, {});
    if (!completions) return [];

    return completions.entries
      .slice(0, 50)
      .map((entry) => new CompletionItemImpl(entry.name, entry.kind, entry.kindModifiers, entry.sortText));
  }

  async getDiagnostics(filePath: string, severity?: string): Promise<Diagnostic[]> {
    const service = this.getOrCreateService(filePath);

    // Force cleanup of semantic cache to ensure fresh diagnostics
    service.cleanupSemanticCache();

    const syntactic = service.getSyntacticDiagnostics(filePath);
    const semantic = service.getSemanticDiagnostics(filePath);
    const suggestion = service.getSuggestionDiagnostics(filePath);

    const allDiags = [...syntactic, ...semantic, ...suggestion];

    return allDiags
      .filter((diag) => {
        if (!severity) return true;
        const diagSeverity = this.getDiagnosticSeverity(diag);
        return diagSeverity === severity;
      })
      .map(
        (diag) =>
          new DiagnosticImpl(
            diag.file?.fileName || filePath,
            this.getDiagnosticSeverity(diag),
            typeof diag.messageText === "string"
              ? diag.messageText
              : ts.flattenDiagnosticMessageText(diag.messageText, "\n"),
            diag.code,
            diag.start ? this.offsetToPosition(filePath, diag.start) : { line: 1, character: 0 },
            diag.length,
          ),
      );
  }

  async getTypeHierarchy(filePath: string, line: number, character: number): Promise<TypeHierarchyItem | null> {
    const service = this.getOrCreateService(filePath);
    const offset = this.positionToOffset(filePath, line, character);

    const typeDefinition = service.getTypeDefinitionAtPosition(filePath, offset);
    if (!typeDefinition || typeDefinition.length === 0) return null;

    const def = typeDefinition[0];

    // Get program to analyze type relationships
    const program = service.getProgram();
    if (!program) return null;

    const checker = program.getTypeChecker();
    const sourceFile = program.getSourceFile(def.fileName);
    if (!sourceFile) return null;

    // Find the node at the definition position
    const findNodeAtPosition = (node: ts.Node): ts.Node | undefined => {
      if (def.textSpan.start >= node.getStart() && def.textSpan.start < node.getEnd()) {
        return ts.forEachChild(node, findNodeAtPosition) || node;
      }
      return undefined;
    };

    const targetNode = findNodeAtPosition(sourceFile);
    if (!targetNode) {
      return new TypeHierarchyItemImpl(
        def.name,
        def.kind,
        def.fileName,
        this.offsetToPosition(def.fileName, def.textSpan.start),
      );
    }

    // Get type at the node
    const type = checker.getTypeAtLocation(targetNode);
    const symbol = type.getSymbol();

    if (!symbol) {
      return new TypeHierarchyItemImpl(
        def.name,
        def.kind,
        def.fileName,
        this.offsetToPosition(def.fileName, def.textSpan.start),
        [],
        [],
      );
    }

    // Find base types (supertypes)
    const baseTypes: Array<{ name: string; file: string; position: { line: number; character: number } }> = [];
    const derivedTypes: Array<{ name: string; file: string; position: { line: number; character: number } }> = [];

    // Get base types for classes and interfaces
    if (ts.isClassDeclaration(targetNode) || ts.isInterfaceDeclaration(targetNode)) {
      const heritageClauses = targetNode.heritageClauses;
      if (heritageClauses) {
        for (const clause of heritageClauses) {
          for (const typeNode of clause.types) {
            const baseType = checker.getTypeAtLocation(typeNode);
            const baseSymbol = baseType.getSymbol();
            if (baseSymbol) {
              const declarations = baseSymbol.getDeclarations();
              if (declarations && declarations.length > 0) {
                const decl = declarations[0];
                const declSourceFile = decl.getSourceFile();
                baseTypes.push({
                  name: baseSymbol.getName(),
                  file: declSourceFile.fileName,
                  position: this.offsetToPosition(declSourceFile.fileName, decl.getStart()),
                });
              }
            }
          }
        }
      }
    }

    // Finding derived types is more complex - we'd need to search the entire program
    // For now, we'll search through all files in the project for references
    const symbolName = symbol.getName();
    const allSourceFiles = program.getSourceFiles();

    // Collect derived types, deduplicating by name (prefer .ts source over .d.ts)
    const derivedByName = new Map<
      string,
      { name: string; file: string; position: { line: number; character: number } }
    >();

    for (const sf of allSourceFiles) {
      if (sf.fileName.includes("node_modules")) continue;

      const visitor = (node: ts.Node): void => {
        if ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) && node.heritageClauses) {
          for (const clause of node.heritageClauses) {
            for (const typeNode of clause.types) {
              if (ts.isIdentifier(typeNode.expression) && typeNode.expression.text === symbolName) {
                const derivedSymbol = checker.getSymbolAtLocation(node.name!);
                if (derivedSymbol && node.name) {
                  const name = derivedSymbol.getName();
                  const existing = derivedByName.get(name);
                  // Prefer source (.ts/.tsx) over declaration (.d.ts)
                  const isSource = !sf.fileName.endsWith(".d.ts");
                  if (!existing || (isSource && existing.file.endsWith(".d.ts"))) {
                    derivedByName.set(name, {
                      name,
                      file: sf.fileName,
                      position: this.offsetToPosition(sf.fileName, node.name.getStart()),
                    });
                  }
                }
              }
            }
          }
        }
        ts.forEachChild(node, visitor);
      };

      visitor(sf);
    }

    derivedTypes.push(...derivedByName.values());

    return new TypeHierarchyItemImpl(
      def.name,
      def.kind,
      def.fileName,
      this.offsetToPosition(def.fileName, def.textSpan.start),
      baseTypes,
      derivedTypes,
    );
  }

  private getOrCreateService(filePath: string): ts.LanguageService {
    const projectRoot = this.findProjectRoot(filePath);

    // Check if we need to refresh due to file changes
    const existingHost = this.hosts.get(projectRoot);
    if (existingHost?.needsRefresh) {
      // Clear the cache to force re-analysis
      this.services.delete(projectRoot);
      this.hosts.delete(projectRoot);
    }

    if (!this.services.has(projectRoot)) {
      const host = this.createLanguageServiceHost(projectRoot);
      this.hosts.set(projectRoot, host);
      this.services.set(projectRoot, ts.createLanguageService(host));
    }

    // Ensure the file is known to the language service
    const host = this.hosts.get(projectRoot)!;
    if (!host.dynamicFiles.has(filePath) && fs.existsSync(filePath)) {
      host.dynamicFiles.add(filePath);
    }

    // Clear the refresh flag
    host.needsRefresh = false;

    return this.services.get(projectRoot)!;
  }

  private createLanguageServiceHost(projectRoot: string): ExtendedLanguageServiceHost {
    const configPath = ts.findConfigFile(projectRoot, ts.sys.fileExists);
    let configFiles: string[] = [];
    let compilerOptions: ts.CompilerOptions = ts.getDefaultCompilerOptions();

    if (configPath) {
      const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
      const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, projectRoot);
      configFiles = parsedConfig.fileNames;
      compilerOptions = parsedConfig.options;
    }

    const fileVersions = new Map<string, number>();
    const fileContents = new Map<string, string>();
    const fileMtimes = new Map<string, number>();
    const dynamicFiles = new Set<string>(configFiles);

    const host: ExtendedLanguageServiceHost = {
      needsRefresh: false,
      getScriptFileNames: () => [...dynamicFiles],
      getScriptVersion: (fileName) => {
        // For declaration files (dependencies), check mtime to detect rebuilds.
        // TS only calls getScriptSnapshot when version changes, so we must
        // detect staleness here — otherwise rebuilt .d.ts files are never re-read.
        if (fileName.endsWith(".d.ts") && fileContents.has(fileName)) {
          try {
            const mtime = fs.statSync(fileName).mtimeMs;
            const cachedMtime = fileMtimes.get(fileName);
            if (cachedMtime !== undefined && cachedMtime !== mtime) {
              const currentVersion = fileVersions.get(fileName) || 0;
              fileVersions.set(fileName, currentVersion + 1);
              fileContents.delete(fileName);
            }
            fileMtimes.set(fileName, mtime);
          } catch {
            // stat failed — ignore, let snapshot handle it
          }
        }
        const version = fileVersions.get(fileName) || 0;
        return version.toString();
      },
      getScriptSnapshot: (fileName) => {
        if (!fs.existsSync(fileName)) {
          return;
        }

        // Read current file content and track mtime for .d.ts staleness detection
        const currentContent = fs.readFileSync(fileName, "utf8");
        if (fileName.endsWith(".d.ts")) {
          try {
            fileMtimes.set(fileName, fs.statSync(fileName).mtimeMs);
          } catch {}
        }
        const cachedContent = fileContents.get(fileName);

        // If content changed, increment version and force service refresh
        if (cachedContent !== currentContent) {
          const currentVersion = fileVersions.get(fileName) || 0;
          fileVersions.set(fileName, currentVersion + 1);
          fileContents.set(fileName, currentContent);

          // Important: Clear the service cache to force TypeScript to re-analyze
          // This ensures diagnostics and other analysis reflect the current file content
          const needsRefresh = cachedContent !== undefined; // Only refresh if we had cached content
          if (needsRefresh) {
            // We can't call this.invalidateCache from here since 'this' isn't available
            // Instead, we'll set a flag and let the service handle it
            host.needsRefresh = true;
          }
        }

        // Add file to dynamic set if it exists
        dynamicFiles.add(fileName);
        return ts.ScriptSnapshot.fromString(currentContent);
      },
      getCurrentDirectory: () => projectRoot,
      getCompilationSettings: () => compilerOptions,
      getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
      fileExists: ts.sys.fileExists,
      readFile: ts.sys.readFile,
      readDirectory: ts.sys.readDirectory,
      directoryExists: ts.sys.directoryExists,
      getDirectories: ts.sys.getDirectories,
      realpath: ts.sys.realpath,
      dynamicFiles, // Expose for direct access
    };

    return host;
  }

  private findDeclarationNode(node: ts.Node): ts.Node | undefined {
    // Walk up to find the enclosing declaration if we're on its name
    let current: ts.Node | undefined = node;
    while (current) {
      if (ts.isClassDeclaration(current) || ts.isInterfaceDeclaration(current) || ts.isTypeAliasDeclaration(current)) {
        return current;
      }
      // If on an identifier that is the name of a declaration, return the parent
      if (
        ts.isIdentifier(current) &&
        current.parent &&
        (ts.isClassDeclaration(current.parent) ||
          ts.isInterfaceDeclaration(current.parent) ||
          ts.isTypeAliasDeclaration(current.parent)) &&
        getDeclarationName(current.parent) === current
      ) {
        return current.parent;
      }
      current = current.parent;
    }
    return undefined;
  }

  async getCallHierarchy(filePath: string, line: number, character: number): Promise<CallHierarchyItem | null> {
    const service = this.getOrCreateService(filePath);
    const offset = this.positionToOffset(filePath, line, character);

    // Note: TS doesn't have built-in call hierarchy, so we approximate
    const definition = service.getDefinitionAtPosition(filePath, offset);
    if (!definition || definition.length === 0) return null;

    const def = definition[0];
    const references = service.getReferencesAtPosition(def.fileName, def.textSpan.start);

    return new CallHierarchyItemImpl(
      def.name,
      def.kind,
      def.fileName,
      this.offsetToPosition(def.fileName, def.textSpan.start),
      references?.map((r) => ({
        file: r.fileName,
        position: this.offsetToPosition(r.fileName, r.textSpan.start),
      })) || [],
    );
  }

  private tryFindSourceForDist(distPath: string): string | null {
    // /packages/foo/dist/bar.d.ts → /packages/foo/src/bar.ts or .tsx
    const srcPath = distPath
      .replace("/dist/", "/src/")
      .replace(/\.d\.ts$/, ".ts")
      .replace(/\.d\.tsx$/, ".tsx")
      .replace(/\.js$/, ".ts");

    if (fs.existsSync(srcPath)) return srcPath;

    // Try .tsx variant
    const tsxPath = srcPath.replace(/\.ts$/, ".tsx");
    if (fs.existsSync(tsxPath)) return tsxPath;

    return null;
  }

  private async processReferencesRecursively(
    references: Reference[],
    impactMap: Map<string, Set<ImpactNode>>,
    visited: Set<string>,
    maxDepth: number,
    includeTests: boolean,
    currentDepth: number,
  ): Promise<void> {
    if (currentDepth > maxDepth) return;

    for (const ref of references) {
      if (!includeTests && ref.file.endsWith(".test.ts")) {
        continue;
      }

      // Skip the definition itself
      if (ref.isDefinition) continue;

      const key = `${ref.file}:${ref.position.line}:${ref.position.character}`;
      if (visited.has(key)) continue;
      visited.add(key);

      // Find what contains this reference
      const container = await this.findContainingSymbol(ref.file, ref.position.line, ref.position.character);

      const isImport = ref.lineText?.includes("import");

      if (container || isImport) {
        if (!impactMap.has(ref.file)) {
          impactMap.set(ref.file, new Set());
        }

        if (container) {
          impactMap.get(ref.file)!.add(container);

          // Recurse - find references to the container
          if (currentDepth < maxDepth) {
            const containerRefs = await this.getReferences(ref.file, container.line, container.character);

            await this.processReferencesRecursively(
              containerRefs,
              impactMap,
              visited,
              maxDepth,
              includeTests,
              currentDepth + 1,
            );
          }
        } else if (isImport) {
          // For imports, add a module-level impact
          impactMap.get(ref.file)!.add({
            kind: "module",
            name: ref.file
              .split("/")
              .pop()!
              .replace(/\.[^.]+$/, ""),
            line: 1,
            character: 0,
          });
        }
      }
    }
  }

  private async findContainingSymbol(
    filePath: string,
    line: number,
    character: number,
  ): Promise<{ kind: string; name: string; line: number; character: number } | null> {
    const service = this.getOrCreateService(filePath);
    const program = service.getProgram();
    if (!program) return null;

    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) return null;

    const offset = this.positionToOffset(filePath, line, character);

    // Find the node at this position and walk up to find containing function/class
    let node = this.findNodeAtOffset(sourceFile, offset);

    while (node?.parent) {
      if (ts.isFunctionDeclaration(node) && node.name) {
        const pos = this.offsetToPosition(filePath, node.name.getStart());
        return {
          kind: "function",
          name: node.name.text,
          line: pos.line,
          character: pos.character,
        };
      } else if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        const pos = this.offsetToPosition(filePath, node.name.getStart());
        return {
          kind: "method",
          name: node.name.text,
          line: pos.line,
          character: pos.character,
        };
      } else if (ts.isClassDeclaration(node) && node.name) {
        const pos = this.offsetToPosition(filePath, node.name.getStart());
        return {
          kind: "class",
          name: node.name.text,
          line: pos.line,
          character: pos.character,
        };
      } else if (ts.isVariableDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
        // Handle top-level variable declarations
        const pos = this.offsetToPosition(filePath, node.name.getStart());
        return {
          kind: "variable",
          name: node.name.text,
          line: pos.line,
          character: pos.character,
        };
      } else if (ts.isSourceFile(node)) {
        // If we reached the source file without finding a container,
        // this is likely a top-level import or usage
        // Return the file itself as the "container"
        return {
          kind: "module",
          name: sourceFile.fileName
            .split("/")
            .pop()!
            .replace(/\.[^.]+$/, ""),
          line: 1,
          character: 0,
        };
      }
      node = node.parent;
    }

    return null;
  }

  private findNodeAtOffset(node: ts.Node, offset: number): ts.Node | undefined {
    if (offset >= node.getStart() && offset < node.getEnd()) {
      return ts.forEachChild(node, (child) => this.findNodeAtOffset(child, offset)) || node;
    }
    return undefined;
  }

  private findSymbolInFile(
    filePath: string,
    symbolName: string,
    service: ts.LanguageService,
  ): { line: number; character: number } | null {
    const program = service.getProgram();
    if (!program) return null;

    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) return null;

    // Simple text search for the declaration name
    const content = sourceFile.getFullText();
    // Look for common declaration patterns
    for (const prefix of [
      "export function ",
      "export class ",
      "export interface ",
      "export type ",
      "export const ",
      "export enum ",
      "function ",
      "class ",
      "interface ",
      "type ",
      "const ",
      "enum ",
    ]) {
      const idx = content.indexOf(prefix + symbolName);
      if (idx !== -1) {
        return this.offsetToPosition(filePath, idx + prefix.length);
      }
    }

    return null;
  }

  private getExportedSymbols(filePath: string, service: ts.LanguageService): DocumentSymbol[] {
    const program = service.getProgram();
    if (!program) return [];

    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) return [];

    const checker = program.getTypeChecker();
    const moduleSymbol = checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) return [];

    const exports = checker.getExportsOfModule(moduleSymbol);
    const symbols: DocumentSymbol[] = [];

    for (const exp of exports) {
      const declarations = exp.getDeclarations();
      if (!declarations || declarations.length === 0) continue;

      // Use the first declaration in the current file
      const decl = declarations.find((d) => d.getSourceFile().fileName === filePath) || declarations[0];
      const pos = this.offsetToPosition(decl.getSourceFile().fileName, decl.getStart());
      const kind = this.getSymbolKind(exp) || "variable";

      symbols.push(new DocumentSymbolImpl(exp.getName(), kind, pos));
    }

    return symbols;
  }

  private getSymbolDescription(
    filePath: string,
    sym: DocumentSymbol,
    program: ts.Program,
    checker: ts.TypeChecker,
  ): string | undefined {
    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) return undefined;

    const offset = this.positionToOffset(filePath, sym.position.line, sym.position.character);
    const node = this.findNodeAtOffset(sourceFile, offset);
    if (!node) return undefined;

    // Navigation tree positions may point at the declaration start (e.g. `export` keyword)
    // rather than the name identifier. Try the node itself, then look for a named declaration.
    let symbol = checker.getSymbolAtLocation(node);
    if (!symbol) {
      let current: ts.Node | undefined = node;
      while (current && !symbol) {
        const name = getDeclarationName(current);
        if (name) {
          symbol = checker.getSymbolAtLocation(name);
        }
        current = current.parent;
      }
    }
    if (!symbol) return undefined;

    // 1. JSDoc first sentence
    const docs = ts.displayPartsToString(symbol.getDocumentationComment(checker));
    if (docs) {
      const firstSentence = docs.split(/[.\n]/)[0].trim();
      if (firstSentence) return firstSentence.slice(0, 80);
    }

    const declarations = symbol.getDeclarations();
    if (!declarations || declarations.length === 0) return undefined;
    const decl = declarations[0];
    const declSf = decl.getSourceFile();

    // 2. Type alias: first 80 chars of definition
    if (ts.isTypeAliasDeclaration(decl)) {
      const typeText = decl.type.getText(declSf);
      return typeText.length > 80 ? `${typeText.slice(0, 77)}...` : typeText;
    }

    // 3. Function: abbreviated signature
    if (ts.isFunctionDeclaration(decl) || ts.isMethodDeclaration(decl)) {
      const type = checker.getTypeOfSymbolAtLocation(symbol, decl);
      const sigs = type.getCallSignatures();
      if (sigs.length > 0) {
        const sig = checker.signatureToString(sigs[0]);
        return sig.length > 80 ? `${sig.slice(0, 77)}...` : sig;
      }
    }

    // 4. Class: extends info
    if (ts.isClassDeclaration(decl) && decl.heritageClauses) {
      const extendsClause = decl.heritageClauses.find((c) => c.token === ts.SyntaxKind.ExtendsKeyword);
      if (extendsClause) {
        return `extends ${extendsClause.types.map((t) => t.getText(declSf)).join(", ")}`;
      }
    }

    // 5. Interface: extends info
    if (ts.isInterfaceDeclaration(decl) && decl.heritageClauses) {
      const extendsClause = decl.heritageClauses.find((c) => c.token === ts.SyntaxKind.ExtendsKeyword);
      if (extendsClause) {
        return `extends ${extendsClause.types.map((t) => t.getText(declSf)).join(", ")}`;
      }
    }

    return undefined;
  }

  private async buildNestedImpactTree(
    symbolName: string,
    symbolFile: string,
    symbolLine: number,
    symbolChar: number,
    references: Reference[],
    maxDepth: number,
    includeTests: boolean,
    visited: Set<string>,
    currentDepth: number,
  ): Promise<SExprDefinition> {
    const impacts: SExprSerializable[] = [];

    // Process each reference
    for (const ref of references) {
      if (!includeTests && ref.file.endsWith(".test.ts")) {
        continue;
      }

      // Skip the definition itself
      if (ref.isDefinition) continue;

      const refKey = `${ref.file}:${ref.position.line}:${ref.position.character}`;
      if (visited.has(refKey)) {
        // Already visited - add a reference marker to avoid infinite recursion
        impacts.push(sexpr("circular-ref", ref.file.split("/").pop()!, `:line`, ref.position.line));
        continue;
      }
      visited.add(refKey);

      // Find what contains this reference
      const container = await this.findContainingSymbol(ref.file, ref.position.line, ref.position.character);

      if (!container) {
        // For imports or other cases without container
        const isImport = ref.lineText?.includes("import");
        if (isImport) {
          impacts.push(
            sexpr(
              "imports",
              ref.file
                .split("/")
                .pop()!
                .replace(/\.[^.]+$/, ""),
              `:file`,
              ref.file,
            ),
          );
        }
        continue;
      }

      // Build nested impact for this container
      const containerImpacts: SExprSerializable[] = [];

      // If we haven't reached max depth, find what uses this container
      if (currentDepth < maxDepth) {
        const containerRefs = await this.getReferences(ref.file, container.line, container.character);

        // Create a new visited set for this branch to allow the same symbol
        // to be reached through different paths
        const branchVisited = new Set(visited);

        const nestedTree = await this.buildNestedImpactTree(
          container.name,
          ref.file,
          container.line,
          container.character,
          containerRefs,
          maxDepth,
          includeTests,
          branchVisited,
          currentDepth + 1,
        );

        // Extract the impacts from the nested tree
        if (Array.isArray(nestedTree) && nestedTree[0] === SEXPR_TAG && nestedTree[1] === "impact-analysis") {
          // Skip the outer wrapper and symbol name to get just the impacts
          const treeImpacts = nestedTree.slice(2);
          containerImpacts.push(...treeImpacts);
        }
      }

      // Create the impact node
      const impactNode = sexpr(
        "impacted",
        container.name,
        `:kind`,
        container.kind,
        `:file`,
        ref.file.split("/").pop()!,
        `:line`,
        container.line,
        ...containerImpacts,
      );

      impacts.push(impactNode);
    }

    return sexpr("impact-analysis", symbolName, ...impacts);
  }

  private formatImpactAnalysis(
    impactMap: Map<string, Set<ImpactNode>>,
    target: string,
    groupBy: "file" | "component" | "flat" | "nested",
  ): SExprDefinition {
    const impacts: SExprDefinition[] = [];

    for (const [file, nodes] of impactMap) {
      // Deduplicate by (file, name): aggregate occurrences and path count
      const deduped = new Map<string, { kind: string; name: string; occurrences: number[]; paths: number }>();
      for (const node of nodes) {
        const key = node.name;
        const existing = deduped.get(key);
        if (existing) {
          existing.paths++;
          if (!existing.occurrences.includes(node.line)) {
            existing.occurrences.push(node.line);
          }
        } else {
          deduped.set(key, { kind: node.kind, name: node.name, occurrences: [node.line], paths: 1 });
        }
      }

      if (groupBy === "file") {
        const nodesList = [...deduped.values()].map((n) =>
          sexpr(n.kind, n.name, ":occurrences", n.occurrences, ":paths", n.paths),
        );
        impacts.push(sexpr("file", file, ...nodesList));
      } else {
        // flat or component grouping
        for (const node of deduped.values()) {
          impacts.push(
            sexpr(
              "impact",
              ":file",
              file,
              ":kind",
              node.kind,
              ":name",
              node.name,
              ":occurrences",
              node.occurrences,
              ":paths",
              node.paths,
            ),
          );
        }
      }
    }

    return sexpr("impact-analysis", target, ...impacts);
  }

  private async analyzeSymbolAt(
    filePath: string,
    line: number,
    character: number,
    want: AnalyzeWant,
  ): Promise<SExprDefinition> {
    const service = this.getOrCreateService(filePath);
    const offset = this.positionToOffset(filePath, line, character);

    const program = service.getProgram();
    if (!program) throw new Error("Could not get program");

    const sourceFile = program.getSourceFile(filePath);
    if (!sourceFile) throw new Error(`Could not find source file: ${filePath}`);

    const checker = program.getTypeChecker();

    // Try multiple strategies to find the symbol
    let node = this.findNodeAtOffset(sourceFile, offset);
    let symbol: ts.Symbol | undefined;

    // First, check if the position is right after an identifier (common with ### markers)
    // Try to adjust the offset to be inside the identifier
    if (offset > 0) {
      // Try offset - 1 first (common case where ### is right after identifier)
      const adjustedNode = this.findNodeAtOffset(sourceFile, offset - 1);
      if (adjustedNode && ts.isIdentifier(adjustedNode)) {
        node = adjustedNode;
        // Also get symbol directly from the identifier
        symbol = checker.getSymbolAtLocation(adjustedNode);
      } else if (node && ts.isSourceFile(node)) {
        // If we're at the source file level, try going back further
        for (let i = 1; i <= 3 && offset - i >= 0; i++) {
          const tryNode = this.findNodeAtOffset(sourceFile, offset - i);
          if (tryNode && ts.isIdentifier(tryNode)) {
            node = tryNode;
            symbol = checker.getSymbolAtLocation(tryNode);
            break;
          }
        }
      }
    }

    // Strategy 1: Direct symbol at location
    if (node) {
      symbol = checker.getSymbolAtLocation(node);
    }

    // Strategy 2: If we have an identifier node, use it
    if (!symbol && node && ts.isIdentifier(node)) {
      symbol = checker.getSymbolAtLocation(node);
    }

    // Strategy 3: If we didn't find a symbol, try the parent node
    if (!symbol && node?.parent) {
      symbol = checker.getSymbolAtLocation(node.parent);
    }

    // Strategy 4: Walk up the tree looking for a named declaration
    if (!symbol && node) {
      let current: ts.Node | undefined = node;
      while (current && !symbol) {
        const declName = getDeclarationName(current);
        if (declName) {
          symbol = checker.getSymbolAtLocation(declName);
          if (symbol) break;
        }
        current = current.parent;
      }
    }

    if (!symbol) {
      return sexpr("symbol", "unknown", ":at", sexpr("file", filePath, ":line", line, ":char", character));
    }

    // Get the symbol name properly
    let symbolName = symbol.getName();

    // If getName returns a file path, try to get the actual name from declarations
    if (symbolName.includes("/")) {
      const declarations = symbol.getDeclarations();
      if (declarations && declarations.length > 0) {
        const declName = getDeclarationName(declarations[0]);
        if (declName) {
          symbolName = declName.text;
        }
      }
    }
    const parts: SExprSerializable[] = [];

    // Location info
    parts.push(":at", sexpr("file", filePath, ":line", line, ":char", character));

    // Process each requested bundle
    if (want.identity) {
      const identityInfo = await this.getIdentityInfo(symbol, checker);
      parts.push(identityInfo);
    }

    if (want.location) {
      const locationInfo = await this.getLocationInfo(symbol);
      parts.push(locationInfo);
    }

    if (want.type) {
      const typeInfo = await this.getTypeInfo(symbol, node || sourceFile, checker, want.type);
      parts.push(typeInfo);
    }

    if (want.signature) {
      const signatureInfo = await this.getSignatureInfo(symbol, checker);
      if (signatureInfo) parts.push(signatureInfo);
    }

    if (want.hierarchy) {
      const hierarchyInfo = await this.getHierarchyInfo(symbol, checker, program, want.hierarchy);
      parts.push(hierarchyInfo);
    }

    if (want.members) {
      const membersInfo = await this.getMembersInfo(symbol, checker);
      if (membersInfo) parts.push(membersInfo);
    }

    if (want.usage) {
      const usageInfo = await this.getUsageInfo(symbol, filePath, line, character, want.usage);
      parts.push(usageInfo);
    }

    if (want.impact) {
      const impactInfo = await this.getImpactInfo(symbol, filePath, line, character, want.impact);
      parts.push(impactInfo);
    }

    if (want.diagnostics) {
      const diagnosticsInfo = await this.getDiagnosticsInfo(filePath, offset, service, want.diagnostics);
      parts.push(diagnosticsInfo);
    }

    if (want.flow) {
      const flowInfo = await this.getFlowInfo(node || sourceFile, checker);
      parts.push(flowInfo);
    }

    return sexpr("symbol", symbolName, ...parts);
  }

  // Bundle extraction methods
  private async getIdentityInfo(symbol: ts.Symbol, checker: ts.TypeChecker): Promise<SExprDefinition> {
    const flags: string[] = [];

    if (symbol.flags & ts.SymbolFlags.Class) flags.push(":class");
    if (symbol.flags & ts.SymbolFlags.Interface) flags.push(":interface");
    if (symbol.flags & ts.SymbolFlags.Function) flags.push(":function");
    if (symbol.flags & ts.SymbolFlags.Variable) flags.push(":variable");
    if (symbol.flags & ts.SymbolFlags.TypeAlias) flags.push(":type-alias");

    const docs = ts.displayPartsToString(symbol.getDocumentationComment(checker));

    return sexpr("identity", ":kind", this.getSymbolKind(symbol), ":flags", flags, docs ? sexpr(":doc", docs) : null);
  }

  private async getLocationInfo(symbol: ts.Symbol): Promise<SExprDefinition> {
    const declarations = symbol.getDeclarations();
    if (!declarations || declarations.length === 0) {
      return sexpr("location");
    }

    const locations = declarations.map((decl) => {
      const sf = decl.getSourceFile();
      const pos = this.offsetToPosition(sf.fileName, decl.getStart());
      return sexpr("def", ":file", sf.fileName, ":line", pos.line, ":char", pos.character);
    });

    return sexpr("location", ...locations);
  }

  private async getTypeInfo(
    symbol: ts.Symbol,
    node: ts.Node,
    checker: ts.TypeChecker,
    options: boolean | { expanded?: boolean; constraints?: boolean },
  ): Promise<SExprDefinition> {
    // For type aliases, use getDeclaredTypeOfSymbol to get the alias definition
    // instead of getTypeOfSymbolAtLocation which resolves to the default generic parameter
    const type =
      symbol.flags & ts.SymbolFlags.TypeAlias
        ? checker.getDeclaredTypeOfSymbol(symbol)
        : checker.getTypeOfSymbolAtLocation(symbol, node);
    const typeString = checker.typeToString(type);

    const parts = [":type", typeString];

    if (options === true || (typeof options === "object" && options.expanded)) {
      const expandedType = checker.typeToString(
        type,
        node,
        ts.TypeFormatFlags.InTypeAlias |
          ts.TypeFormatFlags.NoTruncation |
          ts.TypeFormatFlags.WriteTypeArgumentsOfSignature,
      );
      if (expandedType !== typeString) {
        parts.push(":expanded", expandedType);
      }
    }

    if (options === true || (typeof options === "object" && options.constraints)) {
      // Add constraint info for generic types
      // TODO: Extract generic constraints
    }

    return sexpr("type", ...parts);
  }

  private async getSignatureInfo(symbol: ts.Symbol, checker: ts.TypeChecker): Promise<SExprDefinition | null> {
    const type = checker.getTypeOfSymbol(symbol);
    const signatures = type.getCallSignatures();

    if (signatures.length === 0) return null;

    const sigInfos = signatures.map((sig) => {
      const params = sig.getParameters().map((param) => {
        const paramType = checker.getTypeOfSymbolAtLocation(param, param.valueDeclaration!);
        return sexpr("param", param.getName(), checker.typeToString(paramType));
      });

      const returnType = checker.typeToString(sig.getReturnType());

      return sexpr("signature", ":params", params, ":returns", returnType);
    });

    return sexpr("signatures", ...sigInfos);
  }

  private async getHierarchyInfo(
    symbol: ts.Symbol,
    checker: ts.TypeChecker,
    program: ts.Program,
    options: boolean | { depth?: number; implementations?: boolean },
  ): Promise<SExprDefinition> {
    const parts: SExprSerializable[] = [];
    const declarations = symbol.getDeclarations();

    if (!declarations || declarations.length === 0) {
      return sexpr("hierarchy");
    }

    // Get the first declaration to analyze
    const declaration = declarations[0];

    // Extract base types (extends/implements)
    if (ts.isClassDeclaration(declaration) || ts.isInterfaceDeclaration(declaration)) {
      const baseTypes: SExprDefinition[] = [];

      if (declaration.heritageClauses) {
        for (const clause of declaration.heritageClauses) {
          const clauseType = clause.token === ts.SyntaxKind.ExtendsKeyword ? "extends" : "implements";

          for (const typeNode of clause.types) {
            const type = checker.getTypeAtLocation(typeNode);
            const baseSymbol = type.getSymbol();

            if (baseSymbol) {
              const baseDecl = baseSymbol.getDeclarations()?.[0];
              if (baseDecl) {
                const pos = this.offsetToPosition(baseDecl.getSourceFile().fileName, baseDecl.getStart());
                baseTypes.push(
                  sexpr(
                    clauseType,
                    baseSymbol.getName(),
                    ":file",
                    baseDecl.getSourceFile().fileName,
                    ":line",
                    pos.line,
                    ":char",
                    pos.character,
                  ),
                );
              }
            }
          }
        }
      }

      if (baseTypes.length > 0) {
        parts.push(":base", baseTypes);
      }
    }

    // If requested, also find implementations
    if (options === true || (options && options.implementations)) {
      const implementations = await this.findImplementations(
        declaration.getSourceFile().fileName,
        this.offsetToPosition(declaration.getSourceFile().fileName, declaration.getStart()).line,
        this.offsetToPosition(declaration.getSourceFile().fileName, declaration.getStart()).character,
      );

      // Extract just the implementation list from the s-expression
      // SExprDefinition is [SEXPR_TAG, tag, ...rest] — tag is at index 1
      if (implementations?.[1] === "implementations") {
        const implList = implementations.slice(3); // Skip SEXPR_TAG, "implementations", and symbol name
        if (implList.length > 0) {
          parts.push(":implementations", implList);
        }
      }
    }

    return sexpr("hierarchy", ...parts);
  }

  private async getMembersInfo(symbol: ts.Symbol, checker: ts.TypeChecker): Promise<SExprDefinition | null> {
    // For classes/interfaces, getDeclaredTypeOfSymbol gives the instance type
    // (getTypeOfSymbol gives the constructor function type, which shows "prototype: any")
    const type =
      symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Interface)
        ? checker.getDeclaredTypeOfSymbol(symbol)
        : checker.getTypeOfSymbol(symbol);
    const properties = type.getProperties();

    if (properties.length === 0) return null;

    const members: SExprDefinition[] = [];
    for (const prop of properties) {
      if (members.length >= 15) break;
      const name = prop.getName();
      // Skip internal/inherited noise
      if (name === "prototype" || name === "__proto__") continue;

      const decl = prop.valueDeclaration ?? prop.declarations?.[0];
      const isMethod = decl ? ts.isMethodDeclaration(decl) || ts.isMethodSignature(decl) : false;

      let typeString = "unknown";
      if (decl) {
        const propType = checker.getTypeOfSymbolAtLocation(prop, decl);
        typeString = checker.typeToString(propType);
      }

      members.push(sexpr(isMethod ? "method" : "field", name, ":type", typeString));
    }

    if (members.length === 0) return null;

    return sexpr("members", ":total", properties.length, ...members);
  }

  private async getUsageInfo(
    symbol: ts.Symbol,
    filePath: string,
    line: number,
    character: number,
    options: boolean | { limit?: number; includeTests?: boolean },
  ): Promise<SExprDefinition> {
    const references = await this.getReferences(filePath, line, character);

    let refs = references;
    if (options && typeof options === "object") {
      if (options.limit) {
        refs = refs.slice(0, options.limit);
      }
      if (options.includeTests === false) {
        refs = refs.filter((ref) => !ref.file.endsWith(".test.ts"));
      }
    }

    const refSexprs = refs.map((ref) =>
      sexpr("ref", ":file", ref.file, ":line", ref.position.line, ":char", ref.position.character),
    );

    return sexpr("usage", ":count", references.length, ":refs", refSexprs);
  }

  private async getImpactInfo(
    symbol: ts.Symbol,
    filePath: string,
    line: number,
    character: number,
    options: boolean | { depth?: number; includeTests?: boolean },
  ): Promise<SExprDefinition> {
    const symbolName = symbol.getName();
    const depth = (options && typeof options === "object" && options.depth) || 2;
    const includeTests = options && typeof options === "object" ? options.includeTests !== false : true;

    // Use our existing impact analysis functionality
    const impact = await this.analyzeImpact(symbolName, filePath, depth, includeTests, "nested");

    // The impact analysis returns a full s-expression, extract the relevant parts
    // SExprDefinition is [SEXPR_TAG, tag, ...rest] — tag is at index 1
    if (impact?.[1] === "impact-analysis") {
      // Return just the impact data without the outer wrapper (skip SEXPR_TAG, tag, symbol name)
      return sexpr("impact", ...impact.slice(3));
    }

    // Fallback to simple usage info
    const usage = await this.getUsageInfo(symbol, filePath, line, character, options);
    return sexpr("impact", usage);
  }

  private async getDiagnosticsInfo(
    filePath: string,
    offset: number,
    service: ts.LanguageService,
    options: boolean | { severity?: string },
  ): Promise<SExprDefinition> {
    const severity = typeof options === "object" ? options.severity : undefined;
    const diagnostics = await this.getDiagnostics(filePath, severity);

    const relevantDiags = diagnostics.filter((diag) => {
      const start = this.positionToOffset(filePath, diag.position.line, diag.position.character);
      const end = start + (diag.length || 0);
      return offset >= start && offset <= end;
    });

    const diagSexprs = relevantDiags.map((diag) =>
      sexpr("diagnostic", ":severity", diag.severity, ":message", diag.message),
    );

    return sexpr("diagnostics", ...diagSexprs);
  }

  private getSymbolKind(symbol: ts.Symbol): string {
    if (symbol.flags & ts.SymbolFlags.Class) return "class";
    if (symbol.flags & ts.SymbolFlags.Interface) return "interface";
    if (symbol.flags & ts.SymbolFlags.Function) return "function";
    if (symbol.flags & ts.SymbolFlags.Variable) return "variable";
    if (symbol.flags & ts.SymbolFlags.TypeAlias) return "type";
    if (symbol.flags & ts.SymbolFlags.Enum) return "enum";
    if (symbol.flags & ts.SymbolFlags.Module) return "module";
    return "unknown";
  }

  private async getFlowInfo(node: ts.Node, checker: ts.TypeChecker): Promise<SExprDefinition> {
    const type = checker.getTypeAtLocation(node);
    const contextualType = checker.getContextualType(node as ts.Expression);

    const parts = [":type", checker.typeToString(type)];

    if (contextualType) {
      parts.push(":contextual", checker.typeToString(contextualType));
    }

    return sexpr("flow", ...parts);
  }

  private offsetToPosition(filePath: string, offset: number): { line: number; character: number } {
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n");

    let currentOffset = 0;
    for (const [i, line] of lines.entries()) {
      const lineLength = line.length + 1;
      if (currentOffset + lineLength > offset) {
        return {
          line: i + 1,
          character: offset - currentOffset,
        };
      }
      currentOffset += lineLength;
    }

    return { line: 1, character: 0 };
  }

  private getLineText(filePath: string, lineNumber: number): string {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      const lines = content.split("\n");
      // lineNumber is 1-based
      if (lineNumber > 0 && lineNumber <= lines.length) {
        return lines[lineNumber - 1];
      }
      return "";
    } catch {
      return "";
    }
  }

  private getDiagnosticSeverity(diag: ts.Diagnostic): string {
    switch (diag.category) {
      case ts.DiagnosticCategory.Error:
        return "error";
      case ts.DiagnosticCategory.Warning:
        return "warning";
      case ts.DiagnosticCategory.Suggestion:
        return "hint";
      case ts.DiagnosticCategory.Message:
        return "info";
      default:
        return "info";
    }
  }
}

// Implementation classes with s-expression serialization
class HoverInfoImpl implements HoverInfo {
  constructor(
    public type: string,
    public documentation?: string,
    public tags?: Array<{ name: string; text?: string }>,
    public fullType?: string,
    public expandedType?: string,
    public heritage?: string,
    public constructorSig?: string,
    public ownMembers?: Array<{ name: string; type: string; memberKind: "field" | "method" }>,
    public totalMembers?: number,
  ) {}

  [Symbol.toSExpr]() {
    const parts: SExprSerializable[] = ["hover", this.type];
    if (this.documentation) {
      parts.push(":doc", this.documentation);
    }
    if (this.heritage) {
      parts.push(":heritage", this.heritage);
    }
    if (this.constructorSig) {
      parts.push(":constructor", this.constructorSig);
    }
    if (this.ownMembers && this.ownMembers.length > 0) {
      parts.push(
        ":own-members",
        this.ownMembers.map((m) => sexpr(m.memberKind, m.name, ":type", m.type)),
      );
    }
    if (this.totalMembers != null) {
      parts.push(":total-members", this.totalMembers);
    }
    if (this.fullType) {
      parts.push(":full-type", this.fullType);
    }
    if (this.expandedType) {
      parts.push(":expanded-type", this.expandedType);
    }
    if (this.tags && this.tags.length > 0) {
      parts.push(
        ":tags",
        this.tags.map((t) => [t.name, t.text || ""]),
      );
    }
    return [SEXPR_TAG, ...parts];
  }
}

class DefinitionImpl implements Definition {
  constructor(
    public file: string,
    public position: { line: number; character: number },
    public kind: string,
    public name: string,
    public source: boolean = true,
  ) {}

  [Symbol.toSExpr]() {
    return sexpr(
      "definition",
      this.name,
      ":file",
      this.file,
      ":line",
      this.position.line,
      ":char",
      this.position.character,
      ":kind",
      this.kind,
      ":source",
      this.source,
    );
  }
}

class ReferenceImpl implements Reference {
  constructor(
    public file: string,
    public position: { line: number; character: number },
    public length: number,
    public isWrite: boolean,
    public isDefinition: boolean,
    public lineText?: string,
  ) {}

  [Symbol.toSExpr]() {
    const args: SExprSerializable[] = [
      "reference",
      this.file,
      ":line",
      this.position.line,
      ":char",
      this.position.character,
    ];

    // Add optional properties only if meaningful
    if (this.length !== 0) {
      args.push(":length", this.length);
    }

    if (this.isWrite) {
      args.push(":write");
    }

    if (this.isDefinition) {
      args.push(":definition");
    }

    if (this.lineText) {
      args.push(":text", this.lineText.trim());
    }

    return sexpr(...(args as [string, ...SExprSerializable[]]));
  }
}

class DiagnosticImpl implements Diagnostic {
  constructor(
    public file: string,
    public severity: string,
    public message: string,
    public code: string | number | undefined,
    public position: { line: number; character: number },
    public length?: number,
  ) {}

  [Symbol.toSExpr]() {
    const parts = [
      "diagnostic",
      this.severity,
      this.message,
      ":file",
      this.file,
      ":line",
      this.position.line,
      ":char",
      this.position.character,
    ];
    if (this.code !== undefined) {
      parts.push(":code", this.code);
    }
    if (this.length !== undefined) {
      parts.push(":length", this.length);
    }
    return [SEXPR_TAG, ...parts];
  }
}

class CompletionItemImpl implements CompletionItem {
  constructor(
    public label: string,
    public kind: string,
    public detail?: string,
    public sortText?: string,
  ) {}

  [Symbol.toSExpr]() {
    const parts = ["completion", this.label, ":kind", this.kind];
    if (this.detail) parts.push(":detail", this.detail);
    return [SEXPR_TAG, ...parts];
  }
}

class DocumentSymbolImpl implements DocumentSymbol {
  public description?: string;
  public file?: string;

  constructor(
    public name: string,
    public kind: string,
    public position: { line: number; character: number },
    public parent?: string,
  ) {}

  [Symbol.toSExpr]() {
    const parts: SExprSerializable[] = ["symbol", this.name, ":kind", this.kind, ":line", this.position.line];
    if (this.file) parts.push(":file", this.file);
    if (this.parent) parts.push(":parent", this.parent);
    if (this.description) parts.push(":description", this.description);
    return [SEXPR_TAG, ...parts];
  }
}

class CallHierarchyItemImpl implements CallHierarchyItem {
  constructor(
    public name: string,
    public kind: string,
    public file: string,
    public position: { line: number; character: number },
    public calls: Array<{ file: string; position: { line: number; character: number } }>,
  ) {}

  [Symbol.toSExpr]() {
    return sexpr(
      "call-hierarchy",
      this.name,
      ":kind",
      this.kind,
      ":file",
      this.file,
      ":line",
      this.position.line,
      ":calls",
      this.calls.map((c) => [c.file, c.position.line]),
    );
  }
}

class TypeHierarchyItemImpl implements TypeHierarchyItem {
  constructor(
    public name: string,
    public kind: string,
    public file: string,
    public position: { line: number; character: number },
    public baseTypes?: Array<{ name: string; file: string; position: { line: number; character: number } }>,
    public derivedTypes?: Array<{ name: string; file: string; position: { line: number; character: number } }>,
  ) {}

  [Symbol.toSExpr]() {
    const parts: SExprSerializable[] = [
      "type-hierarchy",
      this.name,
      ":kind",
      this.kind,
      ":file",
      this.file,
      ":line",
      this.position.line,
      ":char",
      this.position.character,
    ];

    if (this.baseTypes && this.baseTypes.length > 0) {
      parts.push(
        ":extends",
        this.baseTypes.map((t) => sexpr("type", t.name, ":file", t.file, ":line", t.position.line)),
      );
    }

    if (this.derivedTypes && this.derivedTypes.length > 0) {
      parts.push(
        ":extended-by",
        this.derivedTypes.map((t) => sexpr("type", t.name, ":file", t.file, ":line", t.position.line)),
      );
    }

    return sexpr(...(parts as [string, ...SExprSerializable[]]));
  }
}
