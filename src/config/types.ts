/**
 * The tribunal.yml config shape. All fields optional — an absent file means "all defaults" and is
 * indistinguishable from no config (config is purely additive).
 */
export interface TribunalConfig {
  /**
   * Per-analyzer enable/disable, keyed by analyzer id. Default: every analyzer enabled. Unknown ids are
   * rejected at load time (typo guard), so a misspelled key fails loudly rather than silently no-op'ing.
   */
  analyzers?: Record<string, boolean>;
  /**
   * EXTRA generated/build-output paths, appended to the built-in defaults. The built-ins (`dist/`,
   * `action-dist/`, …) are always present — config can only ADD coverage, never drop a safety net.
   * See src/paths.ts for the defaults and src/config/loadConfig.ts for merge semantics.
   */
  generatedPaths?: string[];
}
