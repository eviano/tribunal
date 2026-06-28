#!/usr/bin/env node
import { runTribunal, analyzers as defaultAnalyzers } from './index.js';
import { exitCode, renderJson, renderMarkdown } from './report/render.js';
import type { DiffSource } from './diff/gitDiff.js';
import { parseClaims } from './claims.js';
import type { Claim } from './types.js';
import { readFileSync, writeFileSync } from 'node:fs';
import { runPropose, type ProposeProvider } from './propose.js';
import { renderSarif } from './report/render.js';
import { setSkipGenerated, setExtraGeneratedPaths } from './analyzers/riskyDiffNoTest.js';
import { loadConfig, setKnownAnalyzerIds } from './config/loadConfig.js';

// Register the known analyzer ids so loadConfig can validate `analyzers:` keys (fail-loud on typos).
setKnownAnalyzerIds(defaultAnalyzers.map((a) => a.id));

interface CliOptions {
  command: string;
  // check + propose (shared diff source)
  base?: string;
  head?: string;
  diffFile?: string;
  // check-only
  claimsFile?: string;
  prBodyFile?: string;
  // propose-only
  proposePrBodyFile?: string;
  endpoint?: string;
  model?: string;
  apiKey?: string;
  allowSendDiff: boolean;
  outFile?: string;
  // shared
  cwd: string;
  format: 'md' | 'json' | 'sarif';
  hardFail: boolean;
  noSkipGenerated: boolean;
  configFile?: string;
}

const HELP = `tribunal — a deterministic, no-LLM CI gate for agent-authored PRs

Usage:
  tribunal check [options]        Deterministically verify a PR (default).
  tribunal propose [options]      Ask an LLM to PROPOSE claims; never adjudicates.

check — options:
  --base <ref>     Base ref for a range diff (e.g. the PR base branch).
  --head <ref>     Head ref for a range diff. Defaults to working tree vs HEAD.
  --diff <file>    Read a unified diff from a file instead of invoking git.
  --claims <file>  Read machine-readable claims from a file (whole file, or a tribunal fenced block).
  --pr-body <file> Read claims ONLY from a \`\`\`tribunal fenced block in a PR-body file.
  --cwd <dir>      Repo root to run in (default: current directory).
  --format <fmt>   Output format: md (default), json, or sarif (upload via github/codeql-action/upload-sarif).
  --hard-fail      Exit non-zero when there is at least one CONTRADICTED finding.
                   Off by default (report-only). Gates ONLY on CONTRADICTED.
  --no-skip-generated  Don't skip generated/build-output paths in risky-diff-no-test
                   (dist/, *.min.js, …). Default skips them; this re-enables flagging them.
  --config <file>  Path to tribunal.yml (default: <repo-root>/tribunal.yml). Configures per-analyzer
                   enable/disable and extra generated-path patterns. Absent = all defaults.

propose — options:
  --diff <file>      Diff to propose claims for (required for propose).
  --pr-body <file>   Optional PR body to give the model extra context.
  --endpoint <url>   OpenAI-compatible chat-completions base URL (env: TRIBUNAL_ENDPOINT).
  --model <name>     Model name (env: TRIBUNAL_MODEL).
  --api-key <key>    Bearer token (env: TRIBUNAL_API_KEY).
  --allow-send-diff  Actually send the diff to the endpoint. WITHOUT this flag, propose prints the
                     prompt and sends NOTHING (the diff is source code — review before publishing).
                     Also set via TRIBUNAL_ALLOW_SEND_DIFF=1.
  --out <file>       Write the claims block to a file (default: stdout).
  --cwd <dir>        Repo root (default: current directory).

  The propose → check loop:
    tribunal propose --diff pr.diff --allow-send-diff --out claims.md
    tribunal check   --diff pr.diff --pr-body claims.md

Tribunal gates only on CONTRADICTED (a syntactic certainty). UNVERIFIED never blocks,
and no LLM is in the verification path. propose only suggests claims for check to verify.

  -h, --help       Show this help.
`;

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    command: '',
    cwd: process.cwd(),
    format: 'md',
    hardFail: false,
    allowSendDiff: false,
    noSkipGenerated: false,
  };
  const rest = [...argv];
  while (rest.length) {
    const a = rest.shift()!;
    switch (a) {
      case '-h':
      case '--help':
        opts.command = 'help';
        break;
      case '--base':
        opts.base = rest.shift();
        break;
      case '--head':
        opts.head = rest.shift();
        break;
      case '--diff':
        opts.diffFile = rest.shift();
        break;
      case '--claims':
        opts.claimsFile = rest.shift();
        break;
      case '--pr-body':
        // In `propose`, --pr-body is context for the model; in `check`, it's a fenced claims source.
        // We resolve which meaning applies at dispatch time; stash the path on both fields.
        opts.prBodyFile = rest.shift();
        opts.proposePrBodyFile = opts.prBodyFile;
        break;
      case '--endpoint':
        opts.endpoint = rest.shift();
        break;
      case '--model':
        opts.model = rest.shift();
        break;
      case '--api-key':
        opts.apiKey = rest.shift();
        break;
      case '--allow-send-diff':
        opts.allowSendDiff = true;
        break;
      case '--out':
        opts.outFile = rest.shift();
        break;
      case '--cwd':
        opts.cwd = rest.shift() ?? opts.cwd;
        break;
      case '--format': {
        const f = rest.shift();
        if (f === 'md' || f === 'json' || f === 'sarif') opts.format = f;
        else throw new Error(`Unknown format: ${f} (expected md, json, or sarif)`);
        break;
      }
      case '--hard-fail':
        opts.hardFail = true;
        break;
      case '--no-skip-generated':
        opts.noSkipGenerated = true;
        break;
      case '--config':
        opts.configFile = rest.shift();
        break;
      default:
        if (!a.startsWith('-') && !opts.command) opts.command = a;
        else throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

/** Resolve the propose provider config from flags, then env, failing loudly if incomplete. */
function resolveProvider(opts: CliOptions): ProposeProvider {
  const endpoint = opts.endpoint ?? process.env.TRIBUNAL_ENDPOINT;
  const model = opts.model ?? process.env.TRIBUNAL_MODEL;
  const apiKey = opts.apiKey ?? process.env.TRIBUNAL_API_KEY;
  if (!endpoint) {
    throw new Error(
      'propose: no endpoint. Pass --endpoint <url> or set TRIBUNAL_ENDPOINT ' +
        '(an OpenAI-compatible chat-completions base URL).',
    );
  }
  if (!model) {
    throw new Error('propose: no model. Pass --model <name> or set TRIBUNAL_MODEL.');
  }
  return { endpoint, model, apiKey };
}

async function runProposeCmd(opts: CliOptions): Promise<void> {
  if (!opts.diffFile) {
    throw new Error('propose: --diff <file> is required (the diff to propose claims for).');
  }
  const diff = readFileSync(opts.diffFile, 'utf8');
  const prBody = opts.proposePrBodyFile ? readFileSync(opts.proposePrBodyFile, 'utf8') : undefined;

  const allowSendDiff =
    opts.allowSendDiff || process.env.TRIBUNAL_ALLOW_SEND_DIFF === '1' ||
    process.env.TRIBUNAL_ALLOW_SEND_DIFF === 'true';

  const provider = resolveProvider(opts);
  const result = await runPropose({ diff, prBody, provider, allowSendDiff });

  if (opts.outFile) {
    writeFileSync(opts.outFile, `${result.block}\n`);
    process.stderr.write(
      result.sent
        ? `propose: wrote ${result.claims.length} candidate claim(s) to ${opts.outFile}\n`
        : `propose: send-guard withheld the request; wrote an empty block to ${opts.outFile}\n`,
    );
  } else if (result.sent) {
    // When the prompt was already printed by the send-guard path, avoid duplicating it; only print the
    // block when we actually sent and got a response.
    process.stdout.write(`${result.block}\n`);
  }
  process.exit(0);
}

function runCheckCmd(opts: CliOptions): void {
  // riskyDiffNoTest skips generated/build-output paths by default. Disable via --no-skip-generated or
  // TRIBUNAL_NO_SKIP_GENERATED=1 (an opinionated default must never silently suppress a wanted file).
  if (
    opts.noSkipGenerated ||
    process.env.TRIBUNAL_NO_SKIP_GENERATED === '1' ||
    process.env.TRIBUNAL_NO_SKIP_GENERATED === 'true'
  ) {
    setSkipGenerated(false);
  }

  // Load tribunal.yml (auto-discovered at repo root, or --config / TRIBUNAL_CONFIG). Absent = all
  // defaults, no behavior change. Present-but-malformed fails loud. Applied: extra generated-paths are
  // appended to the built-ins (extend-defaults); analyzers: false disables that analyzer.
  let analyzerOverride;
  try {
    const config = loadConfig(opts.cwd, opts.configFile);
    if (config) {
      if (config.generatedPaths && config.generatedPaths.length) {
        setExtraGeneratedPaths(config.generatedPaths);
      }
      if (config.analyzers) {
        const disabled = Object.entries(config.analyzers).filter(([, v]) => v === false).map(([k]) => k);
        if (disabled.length) analyzerOverride = defaultAnalyzers.filter((a) => !disabled.includes(a.id));
      }
    }
  } catch (err) {
    process.stderr.write(`tribunal: ${(err as Error).message}\n`);
    process.exit(2);
  }

  let claims: Claim[] | undefined;
  if (opts.claimsFile) claims = parseClaims(readFileSync(opts.claimsFile, 'utf8'));
  else if (opts.prBodyFile) claims = parseClaims(readFileSync(opts.prBodyFile, 'utf8'), { requireFence: true });

  const src: DiffSource = {
    repoRoot: opts.cwd,
    base: opts.base,
    head: opts.head,
    diffText: opts.diffFile ? readFileSync(opts.diffFile, 'utf8') : undefined,
    claims,
  };

  let report;
  try {
    report = runTribunal(src, analyzerOverride ? { analyzers: analyzerOverride } : {});
  } catch (err) {
    process.stderr.write(`tribunal: ${(err as Error).message}\n`);
    process.exit(2);
  }

  let out: string;
  if (opts.format === 'json') out = renderJson(report);
  else if (opts.format === 'sarif') out = renderSarif(report);
  else out = renderMarkdown(report, opts.hardFail);
  process.stdout.write(`${out}\n`);
  process.exit(exitCode(report, opts.hardFail));
}

async function main(): Promise<void> {
  let opts: CliOptions;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n\n${HELP}`);
    process.exit(2);
  }

  if (opts.command === 'help' || opts.command === '') {
    process.stdout.write(HELP);
    process.exit(0);
  }
  if (opts.command === 'propose') {
    try {
      await runProposeCmd(opts);
    } catch (err) {
      process.stderr.write(`tribunal: ${(err as Error).message}\n`);
      process.exit(2);
    }
    return;
  }
  if (opts.command !== 'check') {
    process.stderr.write(`Unknown command: ${opts.command}\n\n${HELP}`);
    process.exit(2);
  }

  runCheckCmd(opts);
}

main();
