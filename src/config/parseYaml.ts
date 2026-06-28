/**
 * A tiny, zero-dependency parser for the narrow YAML *subset* that tribunal.yml uses.
 *
 * This is deliberately NOT a general YAML parser — it covers exactly what the config schema needs and
 * rejects anything else with a clear error, so a malformed config never silently degrades to defaults:
 *
 *   - top-level `key: value` (value = scalar: string | boolean | number)
 *   - inline list value: `key: [a, b, "c"]`
 *   - block list: a `key:` line followed by `  - item` lines (two-space indent)
 *   - one level of nesting: a `key:` line followed by `  child: value` lines (the `analyzers:` map)
 *   - `#` line comments and trailing comments, blank lines
 *
 * No anchors, no multiline strings, no flow mappings, no deeper nesting. If the schema grows, either
 * extend this or swap in a real parser (js-yaml) — but for now keeping zero runtime deps is a project
 * value, and this subset is fully covered by unit tests.
 */

/** Parse a scalar token (after stripping comments) into string | boolean | number. */
function parseScalar(raw: string): string | boolean | number {
  const s = raw.trim();
  if (s === '') return '';
  // strip surrounding quotes (single or double) → always a string
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  // integer/float only — reject hex/leading-zero quirks by deferring to Number
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return parseFloat(s);
  return s; // bare string
}

/** Parse an inline flow list `[a, b, "c"]` into a (string|number|boolean)[]. */
function parseInlineList(raw: string): unknown[] {
  const inner = raw.trim();
  if (!inner.startsWith('[') || !inner.endsWith(']')) {
    throw new Error(`Expected an inline list '[...]', got: ${raw}`);
  }
  const body = inner.slice(1, -1).trim();
  if (body === '') return [];
  return body.split(',').map((part) => parseScalar(part));
}

/**
 * Strip a trailing `# comment` from a value-bearing line. A `#` only counts as a comment start when
 * preceded by whitespace or at line start (so `#fff` in a value is preserved, ` # note` is stripped).
 */
function stripTrailingComment(line: string): string {
  // naive but sufficient for this subset: a `#` that has a space before it (or is at col 0) is a comment.
  const hash = line.search(/\s#|\s$|^#/);
  if (hash === -1) return line;
  if (line[hash] === '#') return ''; // whole line is a comment
  return line.slice(0, hash);
}

export function parseYamlSubset(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split('\n');

  // State for the current top-level key we're filling (a list or nested map).
  let listKey: string | null = null;
  let mapKey: string | null = null;

  const finishBlock = (): void => {
    listKey = null;
    mapKey = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const original = lines[i];
    const stripped = stripTrailingComment(original);
    // Skip blank / full-comment lines.
    if (stripped.trim() === '' || stripped.trim().startsWith('#')) continue;

    const indent = stripped.length - stripped.trimStart().length;

    // Indented block item under the current list key: `  - value`.
    if (listKey && /^-\s+/.test(stripped.trim())) {
      const item = parseScalar(stripped.trim().replace(/^-\s+/, ''));
      (result[listKey] as unknown[]).push(item);
      continue;
    }
    // Indented child under the current map key: `  child: value`.
    if (mapKey && indent >= 2 && /^[\w-]+:\s*/.test(stripped.trim())) {
      const m = stripped.trim().match(/^([\w-]+):\s*(.*)$/);
      if (!m) throw new Error(`tribunal.yml:${i + 1}: malformed map entry: ${original.trim()}`);
      const [, childKey, childValRaw] = m;
      if (childValRaw.trim() === '') {
        throw new Error(`tribunal.yml:${i + 1}: nested map under '${mapKey}.${childKey}' is not supported`);
      }
      (result[mapKey] as Record<string, unknown>)[childKey] = parseScalar(childValRaw);
      continue;
    }

    // Otherwise: a top-level `key: value` or `key:` (opening a block). Must be at indent 0.
    if (indent !== 0) {
      throw new Error(
        `tribunal.yml:${i + 1}: unexpected indentation (no open block): ${original.trim()}`,
      );
    }
    finishBlock();

    const m = stripped.trim().match(/^([\w-]+):\s*(.*)$/);
    if (!m) throw new Error(`tribunal.yml:${i + 1}: expected 'key: value', got: ${original.trim()}`);
    const [, key, valRaw] = m;
    const val = valRaw.trim();

    if (val === '') {
      // Opens a block — we don't yet know if it's a list or a map; decide on the next non-blank line.
      // For our schema, `analyzers:` is a map and `generated-paths:` is a list. Peek ahead.
      const nextNonBlank = lines
        .slice(i + 1)
        .find((l) => stripTrailingComment(l).trim() !== '' && !stripTrailingComment(l).trim().startsWith('#'));
      if (nextNonBlank && /^-\s+/.test(nextNonBlank.trim())) {
        result[key] = [];
        listKey = key;
      } else {
        result[key] = {};
        mapKey = key;
      }
      continue;
    }
    if (val.startsWith('[')) {
      result[key] = parseInlineList(val);
      continue;
    }
    result[key] = parseScalar(val);
  }

  finishBlock();
  return result;
}
