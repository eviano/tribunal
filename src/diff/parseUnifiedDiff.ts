import type { ChangedFile } from '../types.js';

/**
 * Parse a unified `git diff` into the set of files changed and, for each, the 1-based line numbers in
 * the NEW file that were added or modified. Works for any `--unified=N` (including 0).
 *
 * We deliberately track only new-file line numbers: analyzers reason about the post-change tree, so a
 * "touched" node is one whose new-file line range overlaps `addedLines`.
 */
export function parseUnifiedDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  let current: ChangedFile | null = null;
  let newLine = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      current = { path: '', status: 'modified', addedLines: new Set<number>() };
      files.push(current);
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) current.path = m[2];
      continue;
    }
    if (!current) continue;

    if (line.startsWith('new file mode')) {
      current.status = 'added';
    } else if (line.startsWith('deleted file mode')) {
      current.status = 'deleted';
    } else if (line.startsWith('rename to ')) {
      current.path = line.slice('rename to '.length).trim();
      current.status = 'renamed';
    } else if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (p !== '/dev/null') current.path = p.replace(/^b\//, '');
    } else if (line.startsWith('--- ')) {
      // old-file header; ignore
    } else if (line.startsWith('@@')) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) newLine = parseInt(m[1], 10);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      current.addedLines.add(newLine);
      newLine++;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      // removed line: does not advance the new-file counter
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
    } else if (line.startsWith(' ')) {
      // context line (present when unified > 0)
      newLine++;
    }
  }

  return files;
}
