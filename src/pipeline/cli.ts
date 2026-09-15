import { emitPayload, log } from '../lib/log.ts';
import { loadAppConfig } from '../lib/config.ts';
import { files, readJson } from '../lib/paths.ts';
import { assertManifest } from '../types/manifest.ts';
import { compileCarousel } from '../modules/carousel/compiler.ts';
import { printDoctor, runDoctor } from './doctor.ts';
import { acquireLock, runFullPipeline, stepIntelligence, stepProduce, stepPublish } from './orchestrator.ts';

/**
 * Command surface:
 *   intel     [--reuse-scrape] [--no-transcribe]
 *   produce   [--topic <id>] [--skip-render] [--skip-carousel] [--reuse-audio]
 *   carousel                       (re-render slides from the staged manifest)
 *   publish   [--dry-run] [--mode draft|schedule|now]
 *   full      [--dry-run] [--reuse-scrape] [--skip-render]
 *   doctor    [--postiz]
 * Every command accepts --json to print its result payload on stdout.
 */

interface Flags {
  [key: string]: string | boolean | undefined;
}

function parseArgs(argv: string[]): { command: string; flags: Flags } {
  const [command = 'help', ...rest] = argv;
  const flags: Flags = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i]!;
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { command, flags };
}

function str(flags: Flags, key: string): string | undefined {
  const v = flags[key];
  return typeof v === 'string' ? v : undefined;
}

const HELP = `autopostwb — content factory

  npm run doctor   [-- --postiz]
  npm run intel    [-- --reuse-scrape] [--no-transcribe]
  npm run produce  [-- --topic <id>] [--skip-render] [--skip-carousel] [--reuse-audio]
  npm run carousel
  npm run publish  [-- --dry-run] [--mode draft|schedule|now]
  npm run run:full [-- --dry-run] [--reuse-scrape]

Env: POSTIZ_API_KEY, CF_SCRIPT_PROVIDER=claude|template, CF_CLAUDE_MODEL, CF_BRAND_HANDLE, CF_DEBUG=1, CF_QUIET=1
`;

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const json = flags.json === true;
  const emit = (data: unknown) => {
    if (json) emitPayload(data);
  };

  switch (command) {
    case 'doctor': {
      const checks = await runDoctor({ postiz: flags.postiz === true });
      const ok = printDoctor(checks);
      emit({ ok, checks });
      process.exitCode = ok ? 0 : 1;
      return;
    }
    case 'intel': {
      const release = acquireLock();
      try {
        const topics = await stepIntelligence({
          reuseScrape: flags['reuse-scrape'] === true,
          transcribeTopN: flags['no-transcribe'] === true ? 0 : undefined,
        });
        emit(topics);
        log.info(`top candidates:\n${topics.candidates.slice(0, 5).map((c, i) => `  ${i + 1}. [${c.score}] ${c.hookType} — ${c.hook}`).join('\n')}`);
      } finally {
        release();
      }
      return;
    }
    case 'produce': {
      const release = acquireLock();
      try {
        const summary = await stepProduce({
          topicId: str(flags, 'topic'),
          characterId: str(flags, 'character'),
          skipRender: flags['skip-render'] === true,
          skipCarousel: flags['skip-carousel'] === true,
          reuseAudio: flags['reuse-audio'] === true,
        });
        emit(summary);
      } finally {
        release();
      }
      return;
    }
    case 'carousel': {
      const manifest = assertManifest(readJson(files.manifest));
      const slides = await compileCarousel(manifest, loadAppConfig(), { brandHandle: process.env.CF_BRAND_HANDLE ?? '', keepSvg: flags.svg === true });
      emit(slides);
      return;
    }
    case 'publish': {
      const mode = str(flags, 'mode') as 'draft' | 'schedule' | 'now' | undefined;
      const results = await stepPublish({ dryRun: flags['dry-run'] === true, mode });
      emit(results);
      return;
    }
    case 'full': {
      const result = await runFullPipeline({
        dryRun: flags['dry-run'] === true,
        reuseScrape: flags['reuse-scrape'] === true,
        skipRender: flags['skip-render'] === true,
        topicId: str(flags, 'topic'),
      });
      emit(result);
      return;
    }
    default:
      process.stderr.write(HELP);
      process.exitCode = command === 'help' ? 0 : 1;
  }
}

main().catch((err: Error) => {
  log.error(err.message);
  if (process.env.CF_DEBUG === '1' && err.stack) process.stderr.write(err.stack + '\n');
  process.exitCode = 1;
});
