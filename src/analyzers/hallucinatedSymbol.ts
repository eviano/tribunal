import ts from 'typescript';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { Analyzer, AnalyzerContext, Finding, Verdict } from '../types.js';

/**
 * `hallucinated-symbol` (M1: import subset) — flags imports the PR added that reference a module path
 * or a named export that does not exist. This is the highest-precision slice of "hallucinated symbol":
 * an agent importing `{ parseConifg }` from a module that exports `parseConfig`, or importing from a
 * relative path it never created.
 *
 * Trust Contract (docs/SPEC.md §3):
 *  - CONTRADICTED : a syntactic certainty — a RELATIVE import path resolves to no file, or a resolved
 *                   local module statically has no such named export.
 *  - UNVERIFIED   : a bare package import that doesn't resolve (uninstalled / maybe slopsquatted — that
 *                   is Provenance-Lock's job), or a module whose exports cannot be enumerated statically
 *                   (CJS, `export *` to an unresolvable target).
 *  - (no finding) : the path resolves and the named export exists.
 *
 * Default imports are intentionally never flagged: esModuleInterop / CJS synthesize a default, so a
 * missing `export default` is not a certainty.
 */

const SOURCE_EXT_RE = /\.[cm]?[jt]sx?$/i;
const JS_EXT_RE = /\.[cm]?jsx?$/i;
const MAX_REEXPORT_DEPTH = 4;

function scriptKindForPath(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.[cm]?ts$/i.test(path)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

interface Resolution {
  options: ts.CompilerOptions;
  host: ts.ModuleResolutionHost;
}

/** Resolve the way the target repo's own compiler does — read its tsconfig when present. */
function buildResolution(repoRoot: string): Resolution {
  let options: ts.CompilerOptions = {
    allowJs: true,
    target: ts.ScriptTarget.Latest,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const cfgPath = ts.findConfigFile(repoRoot, ts.sys.fileExists, 'tsconfig.json');
  if (cfgPath) {
    const read = ts.readConfigFile(cfgPath, ts.sys.readFile);
    if (!read.error && read.config) {
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(cfgPath));
      options = { ...parsed.options, allowJs: true };
    }
  }
  return { options, host: ts.sys };
}

function resolveModule(spec: string, containingFile: string, r: Resolution): string | undefined {
  return ts.resolveModuleName(spec, containingFile, r.options, r.host).resolvedModule?.resolvedFileName;
}

function safeRead(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

interface Exports {
  names: Set<string>;
  hasDefault: boolean;
  /** True when exports could not be fully enumerated (CJS, unresolvable `export *`, unreadable file). */
  uncertain: boolean;
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

/** Statically collect a module's exported names. Follows local `export *` re-exports, depth-limited. */
function collectExports(file: string, r: Resolution, depth: number, seen: Set<string>): Exports {
  const result: Exports = { names: new Set<string>(), hasDefault: false, uncertain: false };
  if (seen.has(file) || depth > MAX_REEXPORT_DEPTH) {
    result.uncertain = true;
    return result;
  }
  seen.add(file);

  const content = safeRead(file);
  if (content == null) {
    result.uncertain = true;
    return result;
  }

  const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, scriptKindForPath(file));
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
      } else if (stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)) {
        // `export * from '...'`
        const target = resolveModule(stmt.moduleSpecifier.text, file, r);
        if (target) {
          const sub = collectExports(target, r, depth + 1, seen);
          for (const n of sub.names) result.names.add(n);
          if (sub.uncertain) result.uncertain = true;
        } else {
          result.uncertain = true;
        }
      }
    } else if (ts.isExportAssignment(stmt)) {
      sawEsExport = true;
      if (stmt.isExportEquals) result.uncertain = true; // `export =` (CJS interop)
      else result.hasDefault = true; // `export default`
    }
  }

  // A JS/CJS module with no ES exports may export dynamically — we cannot be certain.
  if (!sawEsExport && (JS_EXT_RE.test(file) || /\bmodule\.exports\b|\bexports\./.test(content))) {
    result.uncertain = true;
  }

  return result;
}

function lineOf(sf: ts.SourceFile, pos: number): number {
  return sf.getLineAndCharacterOfPosition(pos).line + 1;
}

function overlaps(addedLines: Set<number>, start: number, end: number): boolean {
  if (addedLines.size === 0) return false;
  for (let l = start; l <= end; l++) if (addedLines.has(l)) return true;
  return false;
}

function mk(
  verdict: Verdict,
  file: string,
  line: number,
  endLine: number,
  title: string,
  detail: string,
): Finding {
  return { analyzer: 'hallucinated-symbol', verdict, file, line, endLine, title, detail };
}

function checkFile(
  sf: ts.SourceFile,
  filePath: string,
  addedLines: Set<number>,
  absFile: string,
  r: Resolution,
): Finding[] {
  const findings: Finding[] = [];

  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const start = lineOf(sf, stmt.getStart(sf));
    const end = lineOf(sf, stmt.getEnd());
    if (!overlaps(addedLines, start, end)) continue;

    const spec = stmt.moduleSpecifier.text;
    const isRelative = spec.startsWith('.') || isAbsolute(spec);
    const resolved = resolveModule(spec, absFile, r);

    if (!resolved) {
      if (isRelative) {
        findings.push(
          mk('CONTRADICTED', filePath, start, end, 'Import path does not exist',
            `'${spec}' does not resolve to any file from ${filePath}.`),
        );
      } else {
        findings.push(
          mk('UNVERIFIED', filePath, start, end, 'Unresolved package import',
            `Package '${spec}' could not be resolved (not installed?). Dependency existence is out of scope for this check.`),
        );
      }
      continue;
    }

    const clause = stmt.importClause;
    if (!clause || !clause.namedBindings || !ts.isNamedImports(clause.namedBindings)) continue;

    const exp = collectExports(resolved, r, 0, new Set());
    for (const el of clause.namedBindings.elements) {
      const imported = (el.propertyName ?? el.name).text;
      if (imported === 'default') continue;
      if (exp.names.has(imported)) continue;
      if (exp.uncertain) {
        findings.push(
          mk('UNVERIFIED', filePath, start, end, 'Unverifiable named import',
            `Could not confirm '${imported}' is exported by '${spec}' (re-exports or non-static exports). Verify manually.`),
        );
      } else {
        findings.push(
          mk('CONTRADICTED', filePath, start, end, 'Import of nonexistent export',
            `'${spec}' has no export named '${imported}'.`),
        );
      }
    }
  }

  return findings;
}

export const hallucinatedSymbol: Analyzer = {
  id: 'hallucinated-symbol',
  title: 'Hallucinated imports',
  description:
    'Flags imports the PR added that reference a module path or named export that does not exist.',
  kind: 'claim-independent',
  run(ctx: AnalyzerContext): Finding[] {
    const r = buildResolution(ctx.repoRoot);
    const findings: Finding[] = [];
    for (const f of ctx.changedFiles) {
      if (f.status === 'deleted') continue;
      if (!SOURCE_EXT_RE.test(f.path)) continue;
      const src = ctx.readFile(f.path);
      if (src == null) continue;
      const absFile = resolve(ctx.repoRoot, f.path);
      const sf = ts.createSourceFile(absFile, src, ts.ScriptTarget.Latest, true, scriptKindForPath(f.path));
      findings.push(...checkFile(sf, f.path, f.addedLines, absFile, r));
    }
    return findings;
  },
};

export const __test__ = { collectExports, buildResolution };
