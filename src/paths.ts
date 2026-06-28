/**
 * Generated/build-output path detection.
 *
 * A bundled artifact (e.g. `action-dist/cli.cjs`) carries the project's own source — including risky
 * vocab like `token` / `secret` — and isn't hand-written source a reviewer can act on. Flagging it is a
 * false-ish positive: technically correct, operationally noisy. `riskyDiffNoTest` skips generated paths
 * so the signal lands on human-authored code.
 *
 * This list is a deliberate, conservative default. It is overridable: set `skipGenerated = false` on
 * the analyzer (via the CLI's `--no-skip-generated` / `TRIBUNAL_NO_SKIP_GENERATED=1`) to disable it
 * entirely — an opinionated default must never silently suppress a file the user wants checked.
 *
 * Scope: advisory, on `riskyDiffNoTest` only. It does NOT affect the verdict path, `exitCode`, or other
 * analyzers.
 */

/** Directory prefixes whose contents are treated as generated (trailing slash = path segment match). */
const GENERATED_DIRS = [
  'dist/',
  'action-dist/',
  'build/',
  'out/',
  '.next/',
  '.output/',
  '.svelte-kit/',
  'coverage/',
  '.turbo/',
  '.cache/',
  'node_modules/',
];

/** File suffixes treated as generated (minified/bundled output). */
const GENERATED_SUFFIXES = ['.min.js', '.min.cjs', '.min.mjs', '.bundle.js'];

/** The full default pattern set, exported so a future config file can extend or replace it. */
export const GENERATED_PATH_PATTERNS: readonly string[] = [...GENERATED_DIRS, ...GENERATED_SUFFIXES];

/**
 * True if a repo-relative path looks like generated/build output. Normalizes to forward slashes so it
 * works regardless of platform. A path matches if any segment begins with a generated dir prefix, or
 * the basename ends with a generated suffix.
 */
export function isGeneratedPath(path: string): boolean {
  if (!path) return false;
  const norm = path.replace(/\\/g, '/');
  for (const dir of GENERATED_DIRS) {
    // match `dir` as the first segment (`dist/...`) OR any nested segment (`pkg/dist/...`)
    if (norm === dir.slice(0, -1) || norm.startsWith(dir) || norm.includes('/' + dir)) return true;
  }
  const base = norm.split('/').pop() ?? norm;
  for (const suffix of GENERATED_SUFFIXES) {
    if (base.endsWith(suffix)) return true;
  }
  return false;
}
