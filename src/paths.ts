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
 * works regardless of platform. A path matches if any segment begins with a generated dir prefix, the
 * basename ends with a generated suffix, OR it matches an extra pattern (from tribunal.yml config).
 *
 * Extra patterns are appended to the built-ins at match time — config can only ADD coverage, never drop
 * a safety net. An extra pattern is matched as: a dir-prefix (vendor-gen with trailing slash), a suffix
 * (.gen.ts), or a simple glob with single-segment star and double-star across segments.
 */
export function isGeneratedPath(path: string, extraPatterns: readonly string[] = []): boolean {
  if (!path) return false;
  // Normalize backslashes to forward slashes so matching is platform-independent.
  const norm = path.indexOf('\\') >= 0 ? path.split('\\').join('/') : path;
  for (const dir of GENERATED_DIRS) {
    // match `dir` as the first segment (e.g. dist/...) OR any nested segment (e.g. pkg/dist/...)
    if (norm === dir.slice(0, -1) || norm.startsWith(dir) || norm.includes('/' + dir)) return true;
  }
  const base = norm.split('/').pop() ?? norm;
  for (const suffix of GENERATED_SUFFIXES) {
    if (base.endsWith(suffix)) return true;
  }
  for (const pat of extraPatterns) {
    if (matchExtraPattern(norm, pat)) return true;
  }
  return false;
}

/**
 * Match a config-supplied extra pattern. Supports plain dir-prefix (`vendor-gen/`), plain suffix
 * (`.gen.ts`), and `*`/`**` globs. Kept deliberately simple — covers the common "this dir/file is
 * generated" cases without a full glob library.
 */
function matchExtraPattern(normPath: string, pattern: string): boolean {
  const p = pattern.trim();
  if (p === '') return false;
  // No glob chars: treat as dir-prefix or suffix (same heuristic as the built-ins).
  if (!/[*?]/.test(p)) {
    if (p.endsWith('/')) return normPath === p.slice(0, -1) || normPath.startsWith(p) || normPath.includes('/' + p);
    const base = normPath.split('/').pop() ?? normPath;
    return base.endsWith(p) || normPath === p;
  }
  // Glob: convert to a regex. `**` → match across segments; `*` → within one segment; escape the rest.
  const re = globToRegex(p);
  // Match the path itself, or any path under a matched dir (so `**/*.gen.ts` and `vendor-gen/**` both
  // behave intuitively).
  return re.test(normPath) || re.test(normPath + '/');
}

/** Convert a simple `*`/`**` glob into a RegExp. */
function globToRegex(glob: string): RegExp {
  let out = '^';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (glob.startsWith('**', i)) {
      out += '.*';
      i += 2;
    } else if (c === '*') {
      out += '[^/]*';
      i += 1;
    } else if (/[a-zA-Z0-9_]/.test(c)) {
      out += c;
      i += 1;
    } else {
      // Escape any other punctuation (., /, -, etc.) for regex safety.
      out += '\\' + c;
      i += 1;
    }
  }
  return new RegExp(out + '$');
}
