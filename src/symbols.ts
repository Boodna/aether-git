import ts from "typescript";

/**
 * A "unit" is the smallest independently-mergeable span of a source file.
 *
 * - Top-level functions, variables, interfaces, types, enums: one unit each, keyed by name.
 * - Classes are split: each member is its own unit (`Class.member`), plus a `Class` shell unit
 *   covering everything that is not a member (decorators, heritage clause, braces). Two agents
 *   editing different methods of the same class therefore never conflict.
 * - Imports collapse into a single `<imports>` unit (merged as a set union, see weave.ts).
 */
export interface SymbolUnit {
  key: string;
  kind: string;
  start: number;
  end: number;
  text: string;
  /** For class members: the owning class unit key. */
  parent?: string;
}

export interface ParsedFile {
  path: string;
  units: Map<string, SymbolUnit>;
  imports: string[];
  syntaxErrors: number;
}

const SCRIPT_KINDS: Record<string, ts.ScriptKind> = {
  ts: ts.ScriptKind.TS,
  tsx: ts.ScriptKind.TSX,
  js: ts.ScriptKind.JS,
  jsx: ts.ScriptKind.JSX,
  mjs: ts.ScriptKind.JS,
  cjs: ts.ScriptKind.JS,
  mts: ts.ScriptKind.TS,
  cts: ts.ScriptKind.TS,
};

export function isParseable(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ext in SCRIPT_KINDS;
}

function declName(node: ts.Node, sf: ts.SourceFile): string | null {
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.map((d) => d.name.getText(sf)).join(",");
  }
  if (ts.isExportAssignment(node)) return "default";
  const named = node as ts.Node & { name?: ts.Node };
  if (named.name) return named.name.getText(sf);
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) return "default";
  return null;
}

function memberName(m: ts.ClassElement, sf: ts.SourceFile, index: number): string {
  if (ts.isConstructorDeclaration(m)) return "constructor";
  if (m.name) {
    const prefix = ts.isGetAccessor(m) ? "get " : ts.isSetAccessor(m) ? "set " : "";
    return prefix + m.name.getText(sf);
  }
  return `#member${index}`;
}

export function parseFile(path: string, source: string): ParsedFile {
  const ext = path.split(".").pop()?.toLowerCase() ?? "ts";
  const sf = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, SCRIPT_KINDS[ext] ?? ts.ScriptKind.TS);
  const units = new Map<string, SymbolUnit>();
  const imports: string[] = [];

  const add = (u: SymbolUnit) => {
    // Overloads / duplicate names: disambiguate deterministically by order.
    let key = u.key;
    for (let i = 2; units.has(key); i++) key = `${u.key}~${i}`;
    units.set(key, { ...u, key });
  };

  sf.statements.forEach((stmt, i) => {
    const start = stmt.getFullStart();
    const end = stmt.getEnd();
    if (ts.isImportDeclaration(stmt) || ts.isImportEqualsDeclaration(stmt)) {
      imports.push(stmt.getText(sf));
      return;
    }
    const name = declName(stmt, sf) ?? `#stmt${i}`;

    if (ts.isClassDeclaration(stmt)) {
      // Shell = class text with member spans removed entirely, so header edits are detectable
      // while adding/removing members (tracked as their own units) leaves the shell unchanged.
      let shell = "";
      let cursor = start;
      stmt.members.forEach((m, mi) => {
        const ms = m.getFullStart();
        const me = m.getEnd();
        shell += source.slice(cursor, ms);
        cursor = me;
        add({ key: `${name}.${memberName(m, sf, mi)}`, kind: ts.SyntaxKind[m.kind], start: ms, end: me, text: source.slice(ms, me), parent: name });
      });
      shell += source.slice(cursor, end);
      add({ key: name, kind: "ClassShell", start, end, text: shell });
      return;
    }

    add({ key: name, kind: ts.SyntaxKind[stmt.kind], start, end, text: source.slice(start, end) });
  });

  const diagnostics = (sf as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
  return { path, units, imports, syntaxErrors: diagnostics.length };
}

/** Normalise whitespace-only differences so reformatting does not count as a semantic edit. */
function norm(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export interface SymbolDiff {
  added: string[];
  removed: string[];
  modified: string[];
  importsChanged: boolean;
}

export function diffUnits(base: ParsedFile | null, next: ParsedFile | null): SymbolDiff {
  const b = base?.units ?? new Map<string, SymbolUnit>();
  const n = next?.units ?? new Map<string, SymbolUnit>();
  const added: string[] = [];
  const removed: string[] = [];
  const modified: string[] = [];
  for (const [k, u] of n) {
    const prev = b.get(k);
    if (!prev) added.push(k);
    else if (norm(prev.text) !== norm(u.text)) modified.push(k);
  }
  for (const k of b.keys()) if (!n.has(k)) removed.push(k);
  const importsChanged = norm((base?.imports ?? []).join("\n")) !== norm((next?.imports ?? []).join("\n"));
  return { added, removed, modified, importsChanged };
}

/** `src/a.ts#Foo.bar` → `{ file: "src/a.ts", symbol: "Foo.bar" }` */
export function splitSymbolId(id: string): { file: string; symbol: string } {
  const i = id.lastIndexOf("#");
  if (i < 0) return { file: id, symbol: "*" };
  return { file: id.slice(0, i).replace(/^\.?\//, ""), symbol: id.slice(i + 1) };
}

/** Does a lease on `claimed` cover an edit to unit `touched` (both bare symbol names in the same file)? */
export function claimCovers(claimed: string, touched: string): boolean {
  if (claimed === "*" || claimed === touched) return true;
  // A lease on a class covers all of its members.
  return touched.startsWith(claimed + ".");
}
