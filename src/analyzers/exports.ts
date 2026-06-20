import ts from 'typescript';

export interface DirectExports {
  names: Set<string>;
  hasDefault: boolean;
  /** True when exports cannot be enumerated statically (re-exports via `export *`, CJS, `export =`). */
  uncertain: boolean;
}

function scriptKindForPath(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.[cm]?ts$/i.test(path)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function addBindingName(name: ts.BindingName, into: Set<string>): void {
  if (ts.isIdentifier(name)) {
    into.add(name.text);
  } else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) addBindingName(el.name, into);
    }
  }
}

/**
 * Collect a module's DIRECTLY-declared exported names from source text (no disk access, no following
 * of `export *`). Any construct whose export set can't be enumerated statically flips `uncertain`,
 * which callers must treat as "cannot decide" rather than "no exports".
 */
export function directExports(content: string, fileName: string): DirectExports {
  const result: DirectExports = { names: new Set<string>(), hasDefault: false, uncertain: false };
  const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, scriptKindForPath(fileName));
  let sawEsExport = false;

  for (const stmt of sf.statements) {
    const mods = ts.canHaveModifiers(stmt) ? ts.getModifiers(stmt) : undefined;
    const hasExport = mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
    const hasDefault = mods?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword) ?? false;

    if (hasExport) {
      sawEsExport = true;
      if (hasDefault) {
        result.hasDefault = true;
        continue;
      }
      if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) addBindingName(d.name, result.names);
      } else if (
        (ts.isFunctionDeclaration(stmt) ||
          ts.isClassDeclaration(stmt) ||
          ts.isInterfaceDeclaration(stmt) ||
          ts.isTypeAliasDeclaration(stmt) ||
          ts.isEnumDeclaration(stmt) ||
          ts.isModuleDeclaration(stmt)) &&
        stmt.name &&
        ts.isIdentifier(stmt.name)
      ) {
        result.names.add(stmt.name.text);
      }
    } else if (ts.isExportDeclaration(stmt)) {
      sawEsExport = true;
      if (stmt.exportClause) {
        if (ts.isNamedExports(stmt.exportClause)) {
          for (const e of stmt.exportClause.elements) result.names.add(e.name.text);
        } else if (ts.isNamespaceExport(stmt.exportClause)) {
          result.names.add(stmt.exportClause.name.text);
        }
      } else if (stmt.moduleSpecifier) {
        result.uncertain = true; // `export * from '...'` — cannot enumerate without resolving
      }
    } else if (ts.isExportAssignment(stmt)) {
      sawEsExport = true;
      if (stmt.isExportEquals) result.uncertain = true; // `export =` (CJS interop)
      else result.hasDefault = true; // `export default`
    }
  }

  if (!sawEsExport && (/\.[cm]?jsx?$/i.test(fileName) || /\bmodule\.exports\b|\bexports\./.test(content))) {
    result.uncertain = true;
  }

  return result;
}
