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
