import fs from 'node:fs';
import path from 'node:path';
import { run, which } from '../../lib/shell.ts';
import { log } from '../../lib/log.ts';
import { ensureDir, paths, writeJson } from '../../lib/paths.ts';
import type { AppConfig } from '../../lib/config.ts';

/**
 * yt-dlp competitor extraction wrapper.
 *
 * Metadata only by default (`--skip-download --dump-json`): the pipeline needs
 * engagement numbers and titles far more often than it needs the bytes, and
 * downloading every candidate would blow through disk on a small server.
 * Audio is pulled only for the top-N candidates the analyzer wants transcribed.
 */

export interface CompetitorVideo {
  id: string;
  url: string;
  title: string;
  description: string;
  channel: string;
  channelId: string;
  channelFollowers: number;
  durationSeconds: number;
  views: number;
  likes: number;
  comments: number;
  /** yt-dlp exposes neither shares nor saves for YouTube; kept for parity with the scoring formula. */
  shares: number;
  saves: number;
  uploadDate: string | null;
  width: number | null;
  height: number | null;
  isVertical: boolean;
  sourceQuery: string;
  tags: string[];
}

interface YtDlpEntry {
  id?: string;
  webpage_url?: string;
  original_url?: string;
  title?: string;
  description?: string;
  channel?: string;
  uploader?: string;
  channel_id?: string;
  uploader_id?: string;
  channel_follower_count?: number;
  duration?: number;
  view_count?: number;
  like_count?: number;
  comment_count?: number;
  repost_count?: number;
  upload_date?: string;
  width?: number;
  height?: number;
  tags?: string[];
  _type?: string;
}

const YT_DLP_TIMEOUT_MS = 10 * 60 * 1000;
const AUDIO_TIMEOUT_MS = 10 * 60 * 1000;
const SUBS_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Datacenter IPs regularly hit YouTube's "confirm you're not a bot" wall.
 * Export YTDLP_COOKIES=/path/cookies.txt (Netscape format, from a logged-in
 * browser) and/or YTDLP_EXTRA_ARGS="--proxy socks5://..." to get past it.
 */
function commonArgs(): string[] {
  const args: string[] = ['--no-warnings', '--retries', '3', '--sleep-requests', '1'];
  if (process.env.YTDLP_COOKIES) args.push('--cookies', process.env.YTDLP_COOKIES);
  if (process.env.YTDLP_EXTRA_ARGS) args.push(...process.env.YTDLP_EXTRA_ARGS.split(/\s+/).filter(Boolean));
  return args;
}

export async function assertYtDlp(): Promise<void> {
  if (!(await which('yt-dlp'))) {
    throw new Error('yt-dlp is not installed. Run scripts/setup-server.sh (or: pipx install yt-dlp).');
  }
}

function toNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeEntry(entry: YtDlpEntry, sourceQuery: string, fallbackFollowers: number): CompetitorVideo | null {
  const id = entry.id;
  if (!id) return null;

  const width = toNumber(entry.width, 0) || null;
  const height = toNumber(entry.height, 0) || null;

  return {
    id,
    url: entry.webpage_url ?? entry.original_url ?? `https://www.youtube.com/watch?v=${id}`,
    title: (entry.title ?? '').trim(),
    description: (entry.description ?? '').trim().slice(0, 4000),
    channel: entry.channel ?? entry.uploader ?? 'unknown',
    channelId: entry.channel_id ?? entry.uploader_id ?? 'unknown',
    channelFollowers: toNumber(entry.channel_follower_count, 0) || fallbackFollowers,
    durationSeconds: Math.round(toNumber(entry.duration, 0)),
    views: toNumber(entry.view_count, 0),
    likes: toNumber(entry.like_count, 0),
    comments: toNumber(entry.comment_count, 0),
    shares: toNumber(entry.repost_count, 0),
    saves: 0,
    uploadDate: entry.upload_date ?? null,
    width,
    height,
    isVertical: width !== null && height !== null ? height > width : true,
    sourceQuery,
    tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 25) : [],
  };
}

function buildTargets(config: AppConfig): Array<{ query: string; label: string }> {
  const { searchProvider, videosPerKeyword } = config.intelligence;
  const targets: Array<{ query: string; label: string }> = [];

  if (searchProvider === 'ytsearch' || searchProvider === 'both') {
    for (const keyword of config.niche.keywords) {
      // ytsearchdate sorts by upload date, surfacing what is working *now* rather than evergreen giants.
      targets.push({ query: `ytsearchdate${videosPerKeyword}:${keyword} shorts`, label: keyword });
    }
  }
  if (searchProvider === 'channels' || searchProvider === 'both') {
    for (const channel of config.niche.competitorChannels) {
      targets.push({ query: channel, label: channel });
    }
  }
  return targets;
}

/** Dump metadata for one search query / channel URL. */
async function dumpTarget(
  target: { query: string; label: string },
  config: AppConfig,
): Promise<CompetitorVideo[]> {
  const args = [
    ...commonArgs(),
    '--skip-download',
    '--dump-json',
    '--ignore-errors',
    '--no-playlist-reverse',
    '--playlist-end',
    String(config.intelligence.videosPerKeyword),
    '--match-filter',
    `duration < ${config.intelligence.maxDurationSeconds}`,
    target.query,
  ];

  const result = await run('yt-dlp', args, { timeoutMs: YT_DLP_TIMEOUT_MS, allowFailure: true });
  if (!result.stdout.trim()) {
    log.warn('yt-dlp returned nothing', { target: target.label, code: result.code });
    return [];
  }

  const videos: CompetitorVideo[] = [];
  for (const line of result.stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let entry: YtDlpEntry;
    try {
      entry = JSON.parse(trimmed) as YtDlpEntry;
    } catch {
      continue;
    }
    const video = normalizeEntry(entry, target.label, config.intelligence.fallbackFollowers);
    if (video) videos.push(video);
  }
  return videos;
}

export interface ScrapeResult {
  scrapedAt: string;
  totalFound: number;
  kept: number;
  videos: CompetitorVideo[];
}

export async function scrapeCompetitors(config: AppConfig): Promise<ScrapeResult> {
  await assertYtDlp();
  const targets = buildTargets(config);
  if (targets.length === 0) {
    throw new Error('No scrape targets. Add niche.keywords or niche.competitorChannels to config/app.config.json.');
  }

  log.step(`Scraping ${targets.length} target(s) via yt-dlp`);
  const seen = new Set<string>();
  const all: CompetitorVideo[] = [];
  let totalFound = 0;

  for (const target of targets) {
    let batch: CompetitorVideo[] = [];
    try {
      batch = await dumpTarget(target, config);
    } catch (err) {
      log.warn('target failed, continuing', { target: target.label, error: (err as Error).message });
      continue;
    }
    totalFound += batch.length;

    for (const video of batch) {
      if (seen.has(video.id)) continue;
      if (video.views < config.intelligence.minViews) continue;
      if (video.durationSeconds > config.intelligence.maxDurationSeconds) continue;
      if (!video.isVertical) continue;
      seen.add(video.id);
      all.push(video);
    }
    log.info('target scraped', { target: target.label, found: batch.length, keptSoFar: all.length });
  }

  const result: ScrapeResult = {
    scrapedAt: new Date().toISOString(),
    totalFound,
    kept: all.length,
    videos: all,
  };
  writeJson(path.join(paths.raw, 'competitors.json'), result);
  log.info('scrape complete', { found: totalFound, kept: all.length });
  return result;
}

/** Pull a 16 kHz mono WAV for one video so faster-whisper can transcribe it. */
export async function downloadAudio(video: CompetitorVideo): Promise<string> {
  const outDir = ensureDir(path.join(paths.raw, 'audio'));
  const target = path.join(outDir, `${video.id}.wav`);
  if (fs.existsSync(target)) {
    log.debug('audio cached', { id: video.id });
    return target;
  }

  await run(
    'yt-dlp',
    [
      ...commonArgs(),
      '-x',
      '--audio-format',
      'wav',
      '--postprocessor-args',
      'ExtractAudio:-ar 16000 -ac 1',
      '-o',
      path.join(outDir, `${video.id}.%(ext)s`),
      video.url,
    ],
    { timeoutMs: AUDIO_TIMEOUT_MS },
  );

  if (!fs.existsSync(target)) {
    throw new Error(`yt-dlp finished but ${target} is missing`);
  }
  return target;
}

/**
 * YouTube's own auto-captions (json3 = per-word timings) for one video.
 * Free, instant and good enough for hook extraction — Whisper is only the
 * fallback for videos without them. Returns null when none exist.
 */
export async function fetchAutoSubs(video: CompetitorVideo, language: string): Promise<string | null> {
  const outDir = ensureDir(path.join(paths.raw, 'subs'));
  const existing = fs.readdirSync(outDir).find((f) => f.startsWith(`${video.id}.`) && f.endsWith('.json3'));
  if (existing) return path.join(outDir, existing);

  const result = await run(
    'yt-dlp',
    [
      ...commonArgs(),
      '--skip-download',
      '--write-auto-subs',
      '--write-subs',
      '--sub-lang',
      `${language},${language}-orig`,
      '--sub-format',
      'json3',
      '-o',
      path.join(outDir, `${video.id}.%(ext)s`),
      video.url,
    ],
    { timeoutMs: SUBS_TIMEOUT_MS, allowFailure: true },
  );
  if (result.code !== 0) log.debug('auto-subs fetch failed', { id: video.id, code: result.code });

  const found = fs.readdirSync(outDir).find((f) => f.startsWith(`${video.id}.`) && f.endsWith('.json3'));
  return found ? path.join(outDir, found) : null;
}
