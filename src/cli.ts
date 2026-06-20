#!/usr/bin/env node
import { runTribunal } from './index.js';
import { exitCode, renderJson, renderMarkdown } from './report/render.js';
import type { DiffSource } from './diff/gitDiff.js';
import { readFileSync } from 'node:fs';

interface CliOptions {
  command: string;
  base?: string;
  head?: string;
  diffFile?: string;
  cwd: string;
  format: 'md' | 'json';
  hardFail: boolean;
}

const HELP = `tribunal — a deterministic, no-LLM CI gate for agent-authored PRs

Usage:
  tribunal check [options]

Options:
  --base <ref>     Base ref for a range diff (e.g. the PR base branch).
  --head <ref>     Head ref for a range diff. Defaults to working tree vs HEAD.
  --diff <file>    Read a unified diff from a file instead of invoking git.
  --cwd <dir>      Repo root to run in (default: current directory).
  --format <fmt>   Output format: md (default) or json.
  --hard-fail      Exit non-zero when there is at least one CONTRADICTED finding.
                   Off by default (report-only). Gates ONLY on CONTRADICTED.
  -h, --help       Show this help.

Tribunal gates only on CONTRADICTED (a syntactic certainty). UNVERIFIED never blocks,
and no LLM is in the verification path.
`;

function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { command: '', cwd: process.cwd(), format: 'md', hardFail: false };
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
      case '--cwd':
        opts.cwd = rest.shift() ?? opts.cwd;
        break;
      case '--format': {
        const f = rest.shift();
        if (f === 'md' || f === 'json') opts.format = f;
        else throw new Error(`Unknown format: ${f} (expected md or json)`);
        break;
      }
      case '--hard-fail':
        opts.hardFail = true;
        break;
      default:
        if (!a.startsWith('-') && !opts.command) opts.command = a;
        else throw new Error(`Unknown argument: ${a}`);
    }
  }
  return opts;
}

function main(): void {
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
  if (opts.command !== 'check') {
    process.stderr.write(`Unknown command: ${opts.command}\n\n${HELP}`);
    process.exit(2);
  }

  const src: DiffSource = {
    repoRoot: opts.cwd,
    base: opts.base,
    head: opts.head,
    diffText: opts.diffFile ? readFileSync(opts.diffFile, 'utf8') : undefined,
  };

  let report;
  try {
    report = runTribunal(src);
  } catch (err) {
    process.stderr.write(`tribunal: ${(err as Error).message}\n`);
    process.exit(2);
  }

  const out = opts.format === 'json' ? renderJson(report) : renderMarkdown(report, opts.hardFail);
  process.stdout.write(`${out}\n`);
  process.exit(exitCode(report, opts.hardFail));
}

main();
