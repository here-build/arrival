/**
 * Query-result shapes returned by TSLanguageServiceWrapper's DTO-typed methods (hover,
 * definition, references, diagnostics, …). These are the plain public interfaces; the
 * s-expression wire form is produced by the matching `*Impl` classes in ts-language-service.ts,
 * which implement these interfaces and add `[Symbol.toSExpr]`. Split out so consumers can type
 * against the result shapes (re-exported from index.ts) without importing the compiler-driven
 * wrapper.
 */
export interface HoverInfo {
  type: string;
  documentation?: string;
  tags?: Array<{ name: string; text?: string }>;
}

export interface Definition {
  file: string;
  position: { line: number; character: number };
  kind: string;
  name: string;
}

export interface Reference {
  file: string;
  position: { line: number; character: number };
  length: number;
  isWrite: boolean;
  isDefinition: boolean;
  lineText?: string;
}

export interface Diagnostic {
  file: string;
  severity: string;
  message: string;
  code?: string | number;
  position: { line: number; character: number };
  length?: number;
}

export interface CompletionItem {
  label: string;
  kind: string;
  detail?: string;
  sortText?: string;
}

export interface DocumentSymbol {
  name: string;
  kind: string;
  position: { line: number; character: number };
  parent?: string;
  description?: string;
  file?: string;
}

export interface CallHierarchyItem {
  name: string;
  kind: string;
  file: string;
  position: { line: number; character: number };
  calls: Array<{ file: string; position: { line: number; character: number } }>;
}

export interface TypeHierarchyItem {
  name: string;
  kind: string;
  file: string;
  position: { line: number; character: number };
  baseTypes?: Array<{ name: string; file: string; position: { line: number; character: number } }>;
  derivedTypes?: Array<{ name: string; file: string; position: { line: number; character: number } }>;
}
