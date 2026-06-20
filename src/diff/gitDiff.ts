import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { AnalyzerContext, ChangedFile } from '../types.js';
import { parseUnifiedDiff } from './parseUnifiedDiff.js';

export interface DiffSource {
  repoRoot: string;
  /** Base ref for a range diff (e.g. the PR base branch). */
  base?: string;
  /** Head ref for a range diff. Defaults to working tree / HEAD. */
  head?: string;
  /** Raw unified diff text. When set, git is not invoked (useful for tests and piped diffs). */
  diffText?: string;
}

/** Resolve the set of changed files from either a raw diff or `git diff`. */
export function getChangedFiles(src: DiffSource): ChangedFile[] {
  if (src.diffText != null) return parseUnifiedDiff(src.diffText);

  const args = ['diff', '--no-color', '--unified=0'];
  if (src.base && src.head) args.push(`${src.base}...${src.head}`);
  else if (src.base) args.push(src.base);
  else args.push('HEAD');

  const out = execFileSync('git', args, {
    cwd: src.repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return parseUnifiedDiff(out);
}

/**
 * Build an AnalyzerContext that reads file contents from the working tree (assumed to be the head
 * checkout). For range diffs in CI, check out `head` before running.
 */
export function makeContext(src: DiffSource): AnalyzerContext {
  const repoRoot = resolve(src.repoRoot);
  const changedFiles = getChangedFiles(src);
  return {
    repoRoot,
    changedFiles,
    readFile(path: string): string | null {
      const full = join(repoRoot, path);
      if (!existsSync(full)) return null;
      try {
        return readFileSync(full, 'utf8');
      } catch {
        return null;
      }
    },
  };
}
