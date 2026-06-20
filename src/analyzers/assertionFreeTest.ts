import ts from 'typescript';
import type { Analyzer, AnalyzerContext, ChangedFile, Finding, Verdict } from '../types.js';

/**
 * `assertion-free-test` — flags tests the PR added/changed that contain NO assertion and therefore can
 * never fail. This is a marquee agent defect: "I added tests" where the test does setup and asserts
 * nothing.
 *
 * Trust Contract (docs/SPEC.md §3):
 *  - PASS         : an assertion is reachable from the test body (directly or via a resolvable local helper).
 *  - CONTRADICTED : a SYNTACTIC CERTAINTY that no assertion can occur — the body is empty, or it contains
 *                   zero function calls, or every call resolves to a local helper that also cannot assert.
 *  - UNVERIFIED   : no assertion found, but the body calls something external/unresolvable that COULD
 *                   assert indirectly. We never guess PASS and never guess CONTRADICTED here.
 */

const TEST_FILE_RE = /(^|[./\\])(test|spec)\.[cm]?[jt]sx?$/i;
const TEST_DIR_RE = /(^|[/\\])(__tests__|tests?)[/\\]/i;
const SOURCE_EXT_RE = /\.[cm]?[jt]sx?$/i;

function isTestFile(path: string): boolean {
  return TEST_FILE_RE.test(path) || (TEST_DIR_RE.test(path) && SOURCE_EXT_RE.test(path));
}

/** Test-defining call roots. `Deno` covers `Deno.test(...)`. */
const TEST_ROOTS = new Set(['it', 'test', 'fit', 'Deno']);
/** Modifiers that mean the test does not run, so its lack of assertions is not a defect. */
const SKIP_MODIFIERS = new Set(['skip', 'todo']);

/** AVA / node:test context-object assertion methods (`t.is`, `t.deepEqual`, ...). */
const CTX_ASSERTIONS = new Set([
  'is', 'not', 'deepEqual', 'notDeepEqual', 'like', 'true', 'false', 'truthy', 'falsy',
  'assert', 'pass', 'fail', 'throws', 'throwsAsync', 'notThrows', 'notThrowsAsync',
  'regex', 'notRegex', 'snapshot',
]);

interface CalleeInfo {
  root?: string;
  hasSkip: boolean;
}

/** Walk a callee chain to its root identifier, noting any `.skip`/`.todo` modifier on the way. */
function calleeInfo(expr: ts.Expression): CalleeInfo {
  let hasSkip = false;
  let node: ts.Expression = expr;
  while (true) {
    if (ts.isCallExpression(node)) {
      node = node.expression;
    } else if (ts.isPropertyAccessExpression(node)) {
      if (SKIP_MODIFIERS.has(node.name.text)) hasSkip = true;
      node = node.expression;
    } else if (ts.isElementAccessExpression(node)) {
      node = node.expression;
    } else {
      break;
    }
  }
  return { root: ts.isIdentifier(node) ? node.text : undefined, hasSkip };
}

/** Find the function/arrow argument that is the test body (the last function-like argument). */
function testBodyFn(call: ts.CallExpression): ts.ArrowFunction | ts.FunctionExpression | undefined {
  for (let i = call.arguments.length - 1; i >= 0; i--) {
    const a = call.arguments[i];
    if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return a;
  }
  return undefined;
}

/** First string-literal argument, used as the human-readable test name. */
function testName(call: ts.CallExpression): string | undefined {
  const a = call.arguments[0];
  if (a && (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a))) return a.text;
  return undefined;
}

interface AssertionVocab {
  /** Identifier names that ARE assertions when called bare, e.g. `expect`, `assert`, `assertEquals`. */
  ids: Set<string>;
  /** Identifier roots whose member calls are assertions, e.g. `assert.equal`, `sinon.assert.*`. */
  memberRoots: Set<string>;
}

/** Build the per-file assertion vocabulary from imports plus globals (`expect`, `assert`). */
function collectVocab(sf: ts.SourceFile): AssertionVocab {
  const ids = new Set<string>(['expect', 'assert']);
  const memberRoots = new Set<string>(['assert', 'sinon', 'chai', 'expect']);

  sf.forEachChild((node) => {
    if (!ts.isImportDeclaration(node) || !node.importClause) return;
    if (!ts.isStringLiteral(node.moduleSpecifier)) return;
    const mod = node.moduleSpecifier.text;
    const fromAssertModule = /assert/i.test(mod);

    const considerBinding = (name: string) => {
      if (name === 'expect' || name === 'should' || /^assert/i.test(name) || fromAssertModule) {
        ids.add(name);
      }
      if (name === 'chai' || name === 'sinon' || name === 'expect' || name === 'assert') {
        memberRoots.add(name);
      }
    };

    const clause = node.importClause;
    if (clause.name) considerBinding(clause.name.text); // default import
    const nb = clause.namedBindings;
    if (nb) {
      if (ts.isNamespaceImport(nb)) {
        memberRoots.add(nb.name.text); // import * as assert / chai
      } else if (ts.isNamedImports(nb)) {
        nb.elements.forEach((e) => considerBinding(e.name.text));
      }
    }
  });

  return { ids, memberRoots };
}

/** Leftmost root identifier of a (possibly chained) expression. */
function rootIdentifier(expr: ts.Expression): ts.Identifier | undefined {
  let node: ts.Expression = expr;
  while (
    ts.isPropertyAccessExpression(node) ||
    ts.isElementAccessExpression(node) ||
    ts.isCallExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  return ts.isIdentifier(node) ? node : undefined;
}

function isAssertionCallee(
  callee: ts.Expression,
  vocab: AssertionVocab,
  ctxParam: string | undefined,
): boolean {
  if (ts.isIdentifier(callee)) return vocab.ids.has(callee.text);
  if (ts.isPropertyAccessExpression(callee)) {
    const root = rootIdentifier(callee);
    if (root) {
      if (vocab.memberRoots.has(root.text)) return true;
      if (ctxParam && root.text === ctxParam && CTX_ASSERTIONS.has(callee.name.text)) return true;
    }
  }
  return false;
}

/** Local module-scope helpers: name → body node, so we can follow `helper()` calls one or more levels. */
function collectHelpers(sf: ts.SourceFile): Map<string, ts.Node> {
  const helpers = new Map<string, ts.Node>();
  sf.forEachChild((node) => {
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      helpers.set(node.name.text, node.body);
    } else if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations) {
        if (
          ts.isIdentifier(d.name) &&
          d.initializer &&
          (ts.isArrowFunction(d.initializer) || ts.isFunctionExpression(d.initializer))
        ) {
          helpers.set(d.name.text, d.initializer.body);
        }
      }
    }
  });
  return helpers;
}

interface BodyAnalysis {
  hasAssertion: boolean;
  callCount: number;
  /** True if some call could not be proven non-asserting (external/unresolvable). */
  hasUnresolved: boolean;
}

const MAX_HELPER_DEPTH = 4;

function analyzeBody(
  body: ts.Node,
  vocab: AssertionVocab,
  ctxParam: string | undefined,
  helpers: Map<string, ts.Node>,
  visited: Set<string>,
  depth: number,
): BodyAnalysis {
  let hasAssertion = false;
  let callCount = 0;
  let hasUnresolved = false;

  const visit = (node: ts.Node): void => {
    if (hasAssertion) return;

    // chai BDD: `result.should.equal(x)` — the assertion signal is the `.should` property.
    if (ts.isPropertyAccessExpression(node) && node.name.text === 'should') {
      hasAssertion = true;
      return;
    }

    if (ts.isCallExpression(node)) {
      callCount++;
      if (isAssertionCallee(node.expression, vocab, ctxParam)) {
        hasAssertion = true;
        return;
      }
      const callee = node.expression;
      const localName = ts.isIdentifier(callee) ? callee.text : undefined;
      if (localName && helpers.has(localName)) {
        if (!visited.has(localName) && depth < MAX_HELPER_DEPTH) {
          visited.add(localName);
          const sub = analyzeBody(helpers.get(localName)!, vocab, undefined, helpers, visited, depth + 1);
          if (sub.hasAssertion) {
            hasAssertion = true;
            return;
          }
          if (sub.hasUnresolved) hasUnresolved = true;
          // else: a fully-resolved helper that cannot assert — contributes a call but nothing asserting.
        } else {
          hasUnresolved = true; // recursion limit / cycle — stay safe.
        }
      } else {
        hasUnresolved = true; // external/unknown call could assert indirectly.
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(body);
  return { hasAssertion, callCount, hasUnresolved };
}

function statementCount(body: ts.ConciseBody): number {
  if (ts.isBlock(body)) return body.statements.length;
  return 1; // expression-bodied arrow
}

function ctxParamName(fn: ts.ArrowFunction | ts.FunctionExpression): string | undefined {
  const p = fn.parameters[0];
  if (p && ts.isIdentifier(p.name)) return p.name.text;
  return undefined;
}

function scriptKindFor(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.[cm]?ts$/i.test(path)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/** Inclusive overlap test between a node's [start,end] line range and the diff's added lines. */
function isTouched(addedLines: Set<number>, startLine: number, endLine: number): boolean {
  if (addedLines.size === 0) return false;
  for (let l = startLine; l <= endLine; l++) {
    if (addedLines.has(l)) return true;
  }
  return false;
}

function analyzeFile(sf: ts.SourceFile, path: string, addedLines: Set<number>): Finding[] {
  const findings: Finding[] = [];
  const vocab = collectVocab(sf);
  const helpers = collectHelpers(sf);

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const info = calleeInfo(node.expression);
      if (info.root && TEST_ROOTS.has(info.root) && !info.hasSkip) {
        const fn = testBodyFn(node);
        if (fn) {
          const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
          const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
          if (isTouched(addedLines, startLine, endLine)) {
            findings.push(evaluateTest(node, fn, sf, path, vocab, helpers, startLine, endLine));
          }
          // Don't descend into the test body looking for nested tests — tests don't nest meaningfully.
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  return findings;
}

function evaluateTest(
  call: ts.CallExpression,
  fn: ts.ArrowFunction | ts.FunctionExpression,
  sf: ts.SourceFile,
  path: string,
  vocab: AssertionVocab,
  helpers: Map<string, ts.Node>,
  startLine: number,
  endLine: number,
): Finding {
  const name = testName(call);
  const label = name ? `"${name}"` : 'this test';
  const ctxParam = ctxParamName(fn);
  const analysis = analyzeBody(fn.body, vocab, ctxParam, helpers, new Set(), 0);

  let verdict: Verdict;
  let title: string;
  let detail: string;

  if (analysis.hasAssertion) {
    verdict = 'PASS';
    title = 'Test asserts';
    detail = `${label} contains at least one assertion.`;
  } else if (statementCount(fn.body) === 0) {
    verdict = 'CONTRADICTED';
    title = 'Test body is empty';
    detail = `${label} has an empty body and asserts nothing — it can never fail.`;
  } else if (analysis.callCount === 0) {
    verdict = 'CONTRADICTED';
    title = 'Test asserts nothing';
    detail = `${label} has no assertions and calls nothing that could assert — it can never fail.`;
  } else if (analysis.hasUnresolved) {
    verdict = 'UNVERIFIED';
    title = 'No assertion found';
    detail =
      `No assertion was detected in ${label}, but it calls a function Tribunal cannot resolve ` +
      `(an external/imported helper) that may assert. Verify manually.`;
  } else {
    verdict = 'CONTRADICTED';
    title = 'Test asserts nothing';
    detail =
      `${label} only calls local helpers that contain no assertions — it can never fail.`;
  }

  return {
    analyzer: 'assertion-free-test',
    verdict,
    file: path,
    line: startLine,
    endLine,
    title,
    detail,
  };
}

export const assertionFreeTest: Analyzer = {
  id: 'assertion-free-test',
  title: 'Assertion-free tests',
  description:
    'Flags tests the PR added or changed that contain no assertion and therefore can never fail.',
  kind: 'claim-independent',
  run(ctx: AnalyzerContext): Finding[] {
    const findings: Finding[] = [];
    for (const f of ctx.changedFiles) {
      if (f.status === 'deleted') continue;
      if (!isTestFile(f.path)) continue;
      const src = ctx.readFile(f.path);
      if (src == null) continue;
      const sf = ts.createSourceFile(f.path, src, ts.ScriptTarget.Latest, true, scriptKindFor(f.path));
      findings.push(...analyzeFile(sf, f.path, f.addedLines));
    }
    return findings;
  },
};

// Exposed for unit tests that drive a single source string directly.
export const __test__ = { analyzeFile, isTestFile, scriptKindFor };
