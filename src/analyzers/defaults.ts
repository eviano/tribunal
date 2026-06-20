import ts from 'typescript';

function scriptKindForPath(path: string): ts.ScriptKind {
  if (/\.tsx$/i.test(path)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(path)) return ts.ScriptKind.JSX;
  if (/\.[cm]?ts$/i.test(path)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/** Only compare defaults that are literals — anything computed can't be diffed soundly, so we skip it. */
function isLiteralLike(n: ts.Expression): boolean {
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isNumericLiteral(n)) return true;
  if (
    n.kind === ts.SyntaxKind.TrueKeyword ||
    n.kind === ts.SyntaxKind.FalseKeyword ||
    n.kind === ts.SyntaxKind.NullKeyword
  ) {
    return true;
  }
  if (ts.isIdentifier(n) && n.text === 'undefined') return true;
  if (
    ts.isPrefixUnaryExpression(n) &&
    (n.operator === ts.SyntaxKind.MinusToken || n.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(n.operand)
  ) {
    return true;
  }
  return false;
}

function isFunctionLike(n: ts.Node): n is ts.SignatureDeclaration {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isConstructorDeclaration(n)
  );
}

/**
 * Collect literal default *parameter* values, keyed by a stable name (`fnName:paramName`,
 * `Class.method:paramName`). This is the highest-signal, lowest-false-positive slice of "default flip":
 * `function connect(timeoutMs = 30)` → `connect(timeoutMs = 5000)` is a syntactic, checkable fact.
 */
export function collectDefaultParams(content: string, fileName: string): Map<string, string> {
  const sf = ts.createSourceFile(fileName, content, ts.ScriptTarget.Latest, true, scriptKindForPath(fileName));
  const map = new Map<string, string>();

  const visit = (node: ts.Node, container: string | undefined): void => {
    let name = container;
    if (ts.isFunctionDeclaration(node) && node.name) {
      name = node.name.text;
    } else if (ts.isClassDeclaration(node) && node.name) {
      name = node.name.text;
    } else if (ts.isMethodDeclaration(node) && ts.isIdentifier(node.name)) {
      name = (container ? `${container}.` : '') + node.name.text;
    } else if (ts.isConstructorDeclaration(node)) {
      name = (container ? `${container}.` : '') + 'constructor';
    } else if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
    ) {
      name = node.name.text;
    }

    if (isFunctionLike(node)) {
      const fnName = name ?? '(anonymous)';
      for (const p of node.parameters) {
        if (p.initializer && ts.isIdentifier(p.name) && isLiteralLike(p.initializer)) {
          map.set(`${fnName}:${p.name.text}`, p.initializer.getText(sf));
        }
      }
    }

    ts.forEachChild(node, (child) => visit(child, name));
  };

  visit(sf, undefined);
  return map;
}

/** Does a `fnName:paramName` key match a user-supplied claim argument (param name or fn name)? */
export function keyMatchesArg(key: string, arg: string): boolean {
  const [fnPart, paramPart] = key.split(':');
  return paramPart === arg || fnPart === arg || fnPart.endsWith(`.${arg}`);
}
