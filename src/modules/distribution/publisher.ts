import fs from 'node:fs';
import path from 'node:path';
import { log } from '../../lib/log.ts';
import { files, paths, readJsonIfExists, writeJson } from '../../lib/paths.ts';
import type { PostizConfig, PostizPostRequest, PostizUploadedMedia, PublishResult } from '../../types/postiz.ts';
import type { ProductionPayload } from '../../types/manifest.ts';
import { PostizClient } from './postiz.client.ts';

/**
 * Orchestrates single-reel and multi-image carousel post creation.
 *
 * One Postiz request per artifact kind: the reel goes to the reel channels,
 * the carousel (ordered slide list in a single post) goes to the carousel
 * channels. The manifest's postizChannelIds, when non-empty, override both.
 */

export interface PublishOptions {
  /** Validate, build payloads and log them without touching Postiz. */
  dryRun?: boolean;
  /** Override the manifest's scheduledTimestamp (ISO string). */
  scheduledAt?: string;
  /** 'now' posts immediately; 'schedule' honours the timestamp; 'draft' parks it in Postiz. */
  mode?: PostizPostRequest['type'];
}

interface PublishLogEntry {
  runId: string;
  kind: PublishResult['kind'];
  channelIds: string[];
  scheduledFor: string;
  postIds: string[];
  at: string;
}

const LEGAL_FOOTER = 'БАД. Не является лекарственным средством.';

/**
 * Platform caps observed on live publishes (ossclip, 08.2026): Instagram's
 * URL-fetch ingest rejects files around 100MB; duration caps are the
 * platforms' own. Over-cap channels are skipped, the rest still publish.
 */
export const PLATFORM_SIZE_CAP_BYTES: Record<string, number> = { instagram: 95_000_000 };
export const PLATFORM_DURATION_CAP_SEC: Record<string, number> = { threads: 300, tiktok: 600, instagram: 900 };

function withLegalFooter(caption: string, category: string): string {
  // ст. 25 ФЗ «О рекламе»: any post that can be read as promoting a dietary
  // supplement carries the disclaimer. Cheap to always include in this niche.
  if (caption.includes(LEGAL_FOOTER)) return caption;
  const needs = /бад|добавк|витамин|омега|магни|коллаген|железо/i.test(`${caption} ${category}`);
  return needs ? `${caption}\n\n${LEGAL_FOOTER}` : caption;
}

export function buildCaption(manifest: ProductionPayload): string {
  const tags = manifest.distribution.hashtags
    .map((h) => (h.startsWith('#') ? h : `#${h}`))
    .filter((h, i, arr) => arr.indexOf(h) === i)
    .join(' ');
  const body = withLegalFooter(manifest.distribution.captionText.trim(), manifest.topic.category);
  return tags ? `${body}\n\n${tags}` : body;
}

/**
 * Next free slot from postiz.config schedule, at least leadMinutes ahead.
 * Slots are wall-clock times in the configured timezone.
 */
export function nextSlot(config: PostizConfig, kind: PublishResult['kind'], now = new Date()): string {
  const slots = kind === 'reel' ? config.schedule.reelSlots : config.schedule.carouselSlots;
  if (slots.length === 0) return new Date(now.getTime() + config.schedule.leadMinutes * 60_000).toISOString();

  const earliest = now.getTime() + config.schedule.leadMinutes * 60_000;
  const tz = config.schedule.timezone;

  for (let dayOffset = 0; dayOffset < 8; dayOffset += 1) {
    const day = new Date(now.getTime() + dayOffset * 86_400_000);
    const ymd = day.toLocaleDateString('en-CA', { timeZone: tz }); // YYYY-MM-DD in tz
    for (const slot of [...slots].sort()) {
      const candidate = zonedTimeToUtc(`${ymd}T${slot}:00`, tz);
      if (candidate.getTime() >= earliest) return candidate.toISOString();
    }
  }
  return new Date(earliest).toISOString();
}

/** Minimal tz conversion without a dependency: find the UTC instant whose wall time in tz matches. */
function zonedTimeToUtc(localIso: string, timeZone: string): Date {
  const guess = new Date(`${localIso}Z`);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = Object.fromEntries(fmt.formatToParts(guess).map((p) => [p.type, p.value]));
  const asUtc = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  const offset = asUtc - guess.getTime();
  return new Date(guess.getTime() - offset);
}

function resolveChannels(manifest: ProductionPayload, config: PostizConfig, kind: PublishResult['kind']): string[] {
  if (manifest.distribution.postizChannelIds.length > 0) return manifest.distribution.postizChannelIds;
  return kind === 'reel' ? config.channels.reel : config.channels.carousel;
}

/**
 * Per-post `settings` for Postiz. `__type` (platform identifier) is mandatory
 * on every post; YouTube additionally needs `type` (privacy) and Instagram
 * `post_type` — Postiz validates the whole request and rejects it after the
 * upload when one is missing. Config `channelSettings[id]` overrides defaults.
 */
export function buildPostSettings(
  config: PostizConfig,
  channelId: string,
  platform: string | undefined,
  manifest: ProductionPayload,
  kind: PublishResult['kind'],
): Record<string, unknown> {
  const override = config.channelSettings[channelId] ?? {};
  const type = typeof override.__type === 'string' ? override.__type : platform;
  if (!type) {
    throw new Error(
      `Cannot determine the platform of channel ${channelId}: not in GET /integrations and no channelSettings.${channelId}.__type in postiz.config.json`,
    );
  }
  const defaults: Record<string, unknown> = { __type: type };
  if (type === 'youtube') {
    defaults.title = manifest.topic.hook.slice(0, 100);
    // "public" because this is an autoposting factory; use --mode draft (or channelSettings.type = "private") while reviewing.
    defaults.type = 'public';
  }
  if (type === 'instagram') defaults.post_type = kind === 'carousel' ? 'post' : 'post';
  if (type === 'tiktok') {
    defaults.privacy_level = 'PUBLIC_TO_EVERYONE';
    defaults.duet = false;
    defaults.stitch = false;
    defaults.comment = true;
  }
  return { ...defaults, ...override };
}

/** Channels whose platform caps the artifact violates, with the reason. */
export function checkPlatformCaps(
  channelIds: string[],
  platforms: Map<string, string>,
  sizeBytes: number,
  durationSec: number | null,
): Array<{ channelId: string; reason: string }> {
  const skipped: Array<{ channelId: string; reason: string }> = [];
  for (const id of channelIds) {
    const platform = platforms.get(id);
    if (!platform) continue;
    const sizeCap = PLATFORM_SIZE_CAP_BYTES[platform];
    if (sizeCap !== undefined && sizeBytes > sizeCap) {
      skipped.push({ channelId: id, reason: `${platform}: ${Math.round(sizeBytes / 1e6)}MB exceeds ${Math.round(sizeCap / 1e6)}MB cap` });
      continue;
    }
    const durCap = PLATFORM_DURATION_CAP_SEC[platform];
    if (durCap !== undefined && durationSec !== null && durationSec > durCap) {
      skipped.push({ channelId: id, reason: `${platform}: ${Math.round(durationSec)}s exceeds ${durCap}s cap` });
    }
  }
  return skipped;
}

function recordPublish(entry: PublishLogEntry): void {
  const logEntries = readJsonIfExists<PublishLogEntry[]>(files.publishLog) ?? [];
  logEntries.push(entry);
  writeJson(files.publishLog, logEntries);
}

async function dispatch(
  manifest: ProductionPayload,
  config: PostizConfig,
  options: PublishOptions,
  kind: PublishResult['kind'],
  mediaPaths: string[],
): Promise<PublishResult | null> {
  let channelIds = resolveChannels(manifest, config, kind);
  if (channelIds.length === 0) {
    log.warn(`no ${kind} channels configured; skipping ${kind} publish`);
    return null;
  }
  const missing = mediaPaths.filter((p) => !fs.existsSync(p));
  if (missing.length) throw new Error(`${kind} media missing: ${missing.join(', ')}`);

  const scheduledFor = options.scheduledAt ?? manifest.distribution.scheduledTimestamp ?? nextSlot(config, kind);
  const caption = buildCaption(manifest);
  log.step(`Publish ${kind} (${mediaPaths.length} file(s)) -> ${channelIds.length} channel(s) @ ${scheduledFor}`);

  if (options.dryRun) {
    const settingsPreview = Object.fromEntries(
      channelIds.map((id) => [id, buildPostSettings(config, id, config.channelSettings[id]?.__type as string | undefined ?? 'unknown', manifest, kind)]),
    );
    log.info(`dry-run: ${kind} payload`, { channelIds, scheduledFor, media: mediaPaths.length, captionChars: caption.length, settings: settingsPreview });
    return { kind, channelIds, scheduledFor, postIds: [], dispatchedVia: 'rest' };
  }

  const client = new PostizClient(config);
  let postIds: string[];
  if (config.dispatchMode === 'cli') {
    postIds = await client.createPostViaCli(caption, mediaPaths, channelIds, scheduledFor);
  } else {
    const platforms = await client.integrationTypes();
    const totalBytes = mediaPaths.reduce((sum, p) => sum + fs.statSync(p).size, 0);
    const duration = kind === 'reel' ? manifest.script.estimatedDuration : null;
    const skipped = checkPlatformCaps(channelIds, platforms, totalBytes, duration);
    for (const s of skipped) log.warn('channel skipped by platform cap', s);
    channelIds = channelIds.filter((id) => !skipped.some((s) => s.channelId === id));
    if (channelIds.length === 0) throw new Error(`every ${kind} channel was skipped by platform caps`);

    // Upload in order; the array order is the carousel order Postiz sends downstream.
    const media: PostizUploadedMedia[] = [];
    for (const p of mediaPaths) media.push(await client.uploadFile(p));

    postIds = await client.createPost({
      type: options.mode ?? 'schedule',
      date: scheduledFor,
      shortLink: false,
      tags: [],
      posts: channelIds.map((id) => ({
        integration: { id },
        value: [{ content: caption, image: media }],
        settings: buildPostSettings(config, id, platforms.get(id), manifest, kind),
      })),
    });
  }

  const result: PublishResult = { kind, channelIds, scheduledFor, postIds, dispatchedVia: config.dispatchMode };
  recordPublish({ runId: manifest.runId, ...result, at: new Date().toISOString() });
  return result;
}

export async function publishReel(manifest: ProductionPayload, config: PostizConfig, options: PublishOptions = {}): Promise<PublishResult | null> {
  return dispatch(manifest, config, options, 'reel', [files.finalReel]);
}

export async function publishCarousel(manifest: ProductionPayload, config: PostizConfig, options: PublishOptions = {}): Promise<PublishResult | null> {
  const slidePaths = [...manifest.carouselConfig.slides]
    .sort((a, b) => a.index - b.index)
    .map((s) => path.join(paths.carouselOut, `slide_${s.index}.png`));
  return dispatch(manifest, config, options, 'carousel', slidePaths);
}
