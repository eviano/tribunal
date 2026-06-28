import ts from 'typescript';
import type { Analyzer, AnalyzerContext, ChangedFile, Finding } from '../types.js';
import { isGeneratedPath } from '../paths.js';

/**
 * `comment-code-drift` — flags a comment/docstring that references a symbol whose **definition changed**
 * in the diff, where the comment itself wasn't freshly added. Completes SPEC §5a (the last "later"
 * analyzer). Catches the classic agent failure: it edits a function's behavior or renames it, but leaves
 * the docstring describing the old behavior/name.
 *
 * The verdict is load-bearing, same as `risky-diff-no-test`: "does this comment describe stale code?" is
 * a *semantic* judgement, and SPEC §3.4 forbids semantic CONTRADICTED. So this analyzer is
 * **UNVERIFIED-only, never CONTRADICTED** — a signal, never a gate. Safe under `--hard-fail` by
 * construction.
 *
 * Trigger (all must hold):
 *   1. A source file in the diff has a CHANGED declaration for identifier `X` (body edit, rename, or
 *      removal — gathered from base+head ASTs).
 *   2. A comment/docstring (same file OR another changed file) mentions `X` as a whole token.
 *   3. The comment line was NOT added in this diff (a freshly-added comment is unlikely stale — this is
 *      the key false-positive cut).
 *
 * Cross-file: same-file + other changed files (per design). Generated paths and test files are excluded
 * from the "changed symbol" source set (a test mentioning a renamed util is usually fine; a bundle's
 * comments aren't authored).
 */

const SOURCE_EXT_RE = /\.[cm]?[jt]sx?$/i;
const TEST_FILE_RE = /(^|[./\\])(test|spec)\.[cm]?[jt]sx?$/i;
const TEST_DIR_RE = /(^|[/\\])(__tests__|tests?)[/\\]/i;

function isTestPath(path: string): boolean {
  return TEST_FILE_RE.test(path) || (TEST_DIR_RE.test(path) && SOURCE_EXT_RE.test(path));
}

function scriptKindFor(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.[cm]?ts$/i.test(path)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

interface DeclInfo {
  /** Declaration name (e.g. function/class/const/type name). */
  name: string;
  /** 1-based start line of the declaration (the `function foo(...)` line). */
  line: number;
}

/** Collect top-level + class-member declaration names with their declaration line. */
function collectDeclarations(content: string, path: string): DeclInfo[] {
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKindFor(path));
  const out: DeclInfo[] = [];
  const visit = (node: ts.Node): void => {
    const name = declName(node);
    if (name) {
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
      out.push({ name, line });
    }
    // Don't descend into function bodies (locals aren't "documented" at module/class level), but DO
    // descend into class bodies to catch method renames.
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

function declName(node: ts.Node): string | null {
  // Named declarations we care about. NOTE: we handle VariableDeclaration (not VariableStatement) so a
  // `const x` is reported once — visit descends from the statement into its declarators.
  if (ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
    return node.name?.text ?? null;
  }
  if (ts.isVariableDeclaration(node)) {
    return node.name && ts.isIdentifier(node.name) ? node.name.text : null;
  }
  if (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    return node.name.text;
  }
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isPropertyDeclaration(node)) {
    return ts.isIdentifier(node.name) ? node.name.text : null;
  }
  return null;
}

/**
 * Identify identifiers whose declaration changed in the diff for one file. A declaration "changed" if:
 *   - its line in base differs from head (body edit / moved), OR
 *   - it exists in base but not head (removed/renamed).
 * Returns the set of changed names plus the file's added-line set (for the "comment not freshly added"
 * exclusion).
 */
function changedSymbolNames(
  baseContent: string | null,
  headContent: string | null,
  path: string,
): { names: Set<string>; addedLines: Set<number> } {
  const names = new Set<string>();
  const addedLines = new Set<number>();
  if (baseContent == null && headContent == null) return { names, addedLines };

  // Determine added/removed lines by a cheap line-set diff (the ChangedFile.addedLines only has ADDS;
  // we also need REMOVED base lines to spot a renamed old name).
  const baseLines = baseContent ? new Set(baseContent.split('\n')) : new Set<string>();
  const headLines = headContent ? headContent.split('\n') : [];
  if (headContent) {
    headLines.forEach((l, i) => {
      if (!baseLines.has(l)) addedLines.add(i + 1);
    });
  }
  // Removed = base lines absent from head.
  const removedLines = new Set<number>();
  const headLineSet = new Set(headLines);
  if (baseContent) {
    baseContent.split('\n').forEach((l, i) => {
      if (!headLineSet.has(l)) removedLines.add(i + 1);
    });
  }

  const baseDecls = baseContent ? collectDeclarations(baseContent, path) : [];
  const headDecls = headContent ? collectDeclarations(headContent, path) : [];
  const headByName = new Map(headDecls.map((d) => [d.name, d.line]));

  // 1) base declarations removed from head (rename/removal) → old name is "changed".
  for (const d of baseDecls) {
    if (!headByName.has(d.name)) names.add(d.name);
  }
  // 2) declarations present in both whose declaration line is on a removed line → body edit or moved.
  for (const d of headDecls) {
    const was = baseDecls.find((b) => b.name === d.name);
    if (was && (removedLines.has(was.line) || addedLines.has(d.line))) {
      names.add(d.name);
    }
  }
  return { names, addedLines };
}

interface CommentMention {
  /** File containing the comment. */
  file: string;
  /** 1-based line of the comment. */
  line: number;
  /** The symbol token it mentioned. */
  symbol: string;
}

/** Find comments in `content` (lines NOT in `addedLines`) that mention any of `symbols` as a token. */
function findStaleCommentMentions(
  content: string,
  path: string,
  symbols: Set<string>,
  addedLines: Set<number>,
): CommentMention[] {
  if (symbols.size === 0 || !content) return [];
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true, scriptKindFor(path));
  const mentions: CommentMention[] = [];
  const symbolSet = new Set(
    [...symbols].filter((s) => s && s.length >= 2 && !COMMON_WORDS.has(s.toLowerCase())),
  );
  if (symbolSet.size === 0) return [];

  const isComment = (kind: ts.SyntaxKind): boolean =>
    kind === ts.SyntaxKind.SingleLineCommentTrivia ||
    kind === ts.SyntaxKind.MultiLineCommentTrivia;

  // `forEachLeadingCommentRange` runs per-node, so the same comment is reported once per following
  // node. Track positions we've already inspected to emit each comment at most once.
  const seenCommentPos = new Set<number>();
  const fullText = sf.text;

  const visit = (node: ts.Node): void => {
    const start = node.getFullStart();
    ts.forEachLeadingCommentRange(fullText, start, (pos, _end, kind) => {
      if (!isComment(kind) || seenCommentPos.has(pos)) return;
      seenCommentPos.add(pos);
      const line = sf.getLineAndCharacterOfPosition(pos).line + 1;
      if (addedLines.has(line)) return; // freshly-added comment → unlikely stale
      const text = fullText.slice(pos, _end);
      const toks = new Set(text.toLowerCase().split(/[^a-z0-9_$]+/i).filter(Boolean));
      for (const sym of symbolSet) {
        if (toks.has(sym) || toks.has(sym.toLowerCase())) {
          mentions.push({ file: path, line, symbol: sym });
        }
      }
    });
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return mentions;
}

// Words too common to treat as a "symbol reference" even if they happen to be a declaration name.
const COMMON_WORDS = new Set([
  'data', 'value', 'item', 'result', 'error', 'options', 'config', 'props', 'state', 'type',
]);

export const commentCodeDrift: Analyzer = {
  id: 'comment-code-drift',
  title: 'Comment may describe changed code',
  description:
    'Signals a comment/docstring that references a symbol whose definition changed in the diff (body ' +
    'edit, rename, or removal), where the comment itself was not freshly added. Never blocks: comment ' +
    'staleness is semantic, so it emits UNVERIFIED only.',
  kind: 'claim-independent',
  run(ctx: AnalyzerContext): Finding[] {
    // No base ref → can't compare; degrade to silence (no false signal).
    if (!ctx.base || !ctx.readBaseFile) return [];

    // 1) Gather changed symbols per changed source file (excluding tests/generated).
    const changedPerFile = new Map<string, { names: Set<string>; addedLines: Set<number> }>();
    for (const f of ctx.changedFiles) {
      if (f.status === 'deleted' || isTestPath(f.path) || !SOURCE_EXT_RE.test(f.path)) continue;
      if (isGeneratedPath(f.path)) continue;
      const baseContent = ctx.readBaseFile(f.path);
      const headContent = ctx.readFile(f.path);
      if (baseContent == null && headContent == null) continue;
      const info = changedSymbolNames(baseContent, headContent, f.path);
      if (info.names.size > 0) changedPerFile.set(f.path, info);
    }
    if (changedPerFile.size === 0) return [];

    // Union of all changed symbol names across changed files (for cross-file comment scan).
    const allChangedNames = new Set<string>();
    for (const info of changedPerFile.values()) for (const n of info.names) allChangedNames.add(n);
    if (allChangedNames.size === 0) return [];

    // 2) Scan comments in each changed file (same-file + cross-file within the changed set).
    const findings: Finding[] = [];
    for (const f of ctx.changedFiles) {
      if (f.status === 'deleted') continue;
      // Comments in test files still count (a test docstring can drift too), but generated paths don't.
      if (!SOURCE_EXT_RE.test(f.path) || isGeneratedPath(f.path)) continue;
      const content = ctx.readFile(f.path);
      if (content == null) continue;
      const mentions = findStaleCommentMentions(content, f.path, allChangedNames, f.addedLines);
      for (const m of mentions) {
        findings.push({
          analyzer: 'comment-code-drift',
          verdict: 'UNVERIFIED',
          file: m.file,
          line: m.line,
          title: 'Comment may describe code that changed',
          detail:
            `A comment here mentions '${m.symbol}', whose definition changed in this PR. The comment ` +
            `may now be stale. 'Stale' is a heuristic, so this never blocks — verify the wording is ` +
            `still accurate.`,
        });
      }
    }
    // Dedupe by (file, line, symbol).
    const seen = new Set<string>();
    return findings.filter((f) => {
      const key = `${f.file}:${f.line}:${(f.detail.match(/'([^']+)'/) ?? ['', ''])[1]}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  },
};

// Exposed for unit tests.
export const __test__ = { collectDeclarations, changedSymbolNames, findStaleCommentMentions };
