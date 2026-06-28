import type { ChangedFile } from '../types.js';

/**
 * Parse a unified `git diff` into the set of files changed and, for each, the 1-based line numbers in
 * the NEW file that were added or modified. Works for any `--unified=N` (including 0).
 *
 * We deliberately track only new-file line numbers: analyzers reason about the post-change tree, so a
 * "touched" node is one whose new-file line range overlaps `addedLines`.
 *
 * Both git-style diffs (`diff --git`) and plain unified diffs (no `diff --git` header, e.g. `diff -u` or
 * a `git format-patch` body) are supported. A plain diff opens a file record on its first `---`/`+++`
 * header so a hand-written or piped patch is never silently dropped to `[]`.
 */
export function parseUnifiedDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  // `current`/`newLine`/`seenPlus` are reassigned across iterations; we read them into a narrowed local
  // (`rec`) where we use them, since TS can't keep a closure-mutated `let` narrowed through the loop.
  let current: ChangedFile | null = null;
  let newLine = 0;
  // True once the current record has consumed its `+++` header. A subsequent `---` then starts the next
  // file (plain unified diffs have no `diff --git` line to delimit files).
  let seenPlus = false;

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git')) {
      const rec: ChangedFile = { path: '', status: 'modified', addedLines: new Set<number>() };
      files.push(rec);
      current = rec;
      seenPlus = false;
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) rec.path = m[2];
      continue;
    }
    // A `---` header opens a record for plain (non-git) unified diffs, and separates consecutive files.
    // In git format `diff --git` already opened the record, and the first `---` arrives before any `+++`
    // (seenPlus === false), so it does not re-open.
    if (line.startsWith('--- ')) {
      if (!current || seenPlus) {
        const rec: ChangedFile = { path: '', status: 'modified', addedLines: new Set<number>() };
        files.push(rec);
        current = rec;
        seenPlus = false;
        const p = line.slice(4).trim();
        // Provisional old-path; kept only when there is no `+++` (e.g. a plain deletion) so the record
        // isn't left pathless. `+++` overrides it for normal adds/modifies.
        if (p && p !== '/dev/null') rec.path = p.replace(/^a\//, '');
      }
      continue;
    }
    const rec = current;
    if (!rec) continue;

    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim();
      if (p !== '/dev/null') rec.path = p.replace(/^b\//, '');
      seenPlus = true;
    } else if (line.startsWith('new file mode')) {
      rec.status = 'added';
    } else if (line.startsWith('deleted file mode')) {
      rec.status = 'deleted';
    } else if (line.startsWith('rename to ')) {
      rec.path = line.slice('rename to '.length).trim();
      rec.status = 'renamed';
    } else if (line.startsWith('@@')) {
      const m = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) newLine = parseInt(m[1], 10);
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      rec.addedLines.add(newLine);
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
