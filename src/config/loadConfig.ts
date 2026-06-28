import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseYamlSubset } from './parseYaml.js';
import type { TribunalConfig } from './types.js';

export const CONFIG_FILENAME = 'tribunal.yml';

/** The set of analyzer ids accepted under `analyzers:` — injected so loadConfig has no analyzer import cycle. */
let knownAnalyzerIds: readonly string[] = [];

/**
 * Register the known analyzer ids (once, at CLI/program startup). loadConfig validates `analyzers:` keys
 * against this set so a typo fails loudly instead of silently no-op'ing.
 */
export function setKnownAnalyzerIds(ids: readonly string[]): void {
  knownAnalyzerIds = ids;
}

/**
 * Load + validate a TribunalConfig.
 *
 * Resolution order for the file path:
 *   1. an explicit `configPath` argument (the `--config` flag value)
 *   2. the `TRIBUNAL_CONFIG` env var
 *   3. `<repoRoot>/tribunal.yml` (auto-discovery)
 *
 * Returns `null` when no file is present (≡ all defaults). Throws on a present-but-malformed file or on
 * an unknown analyzer id (fail-loud, never silently degrade).
 */
export function loadConfig(repoRoot: string, configPath?: string): TribunalConfig | null {
  const explicit = configPath ?? process.env.TRIBUNAL_CONFIG;
  const file = explicit ? resolve(explicit) : join(repoRoot, CONFIG_FILENAME);
  if (!existsSync(file)) return null;

  let raw: string;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`tribunal.yml: could not read ${file}: ${(err as Error).message}`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = parseYamlSubset(raw);
  } catch (err) {
    throw new Error(`${(err as Error).message} (in ${file})`);
  }

  const config: TribunalConfig = {};

  // analyzers: map of id → boolean, validated against the known registry.
  if ('analyzers' in parsed && parsed.analyzers != null) {
    const a = parsed.analyzers;
    if (typeof a !== 'object' || Array.isArray(a)) {
      throw new Error(`tribunal.yml: 'analyzers' must be a map of id: true|false (in ${file})`);
    }
    const known = new Set(knownAnalyzerIds);
    if (known.size === 0) {
      // Defensive: caller forgot to register ids. Allow through without validation rather than block.
    }
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(a as Record<string, unknown>)) {
      if (known.size > 0 && !known.has(k)) {
        throw new Error(
          `tribunal.yml: unknown analyzer '${k}'. Known: ${[...known].sort().join(', ')} (in ${file})`,
        );
      }
      if (typeof v !== 'boolean') {
        throw new Error(`tribunal.yml: analyzers.${k} must be true|false, got ${JSON.stringify(v)} (in ${file})`);
      }
      out[k] = v;
    }
    config.analyzers = out;
  }

  // generated-paths: list of strings, appended to built-ins at match time.
  if ('generated-paths' in parsed && parsed['generated-paths'] != null) {
    const gp = parsed['generated-paths'];
    if (!Array.isArray(gp)) {
      throw new Error(`tribunal.yml: 'generated-paths' must be a list (in ${file})`);
    }
    config.generatedPaths = gp.map((item, idx) => {
      if (typeof item !== 'string') {
        throw new Error(`tribunal.yml: generated-paths[${idx}] must be a string (in ${file})`);
      }
      return item;
    });
  }

  // Reject unknown top-level keys (fail-loud — typos shouldn't silently no-op).
  const knownKeys = new Set(['analyzers', 'generated-paths']);
  for (const k of Object.keys(parsed)) {
    if (!knownKeys.has(k)) {
      throw new Error(
        `tribunal.yml: unknown key '${k}'. Supported: ${[...knownKeys].join(', ')} (in ${file})`,
      );
    }
  }

  return config;
}
