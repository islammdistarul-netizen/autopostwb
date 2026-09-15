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
 * Provider settings for one channel. `title` (YouTube) defaults to the hook so
 * a config entry of just `{ "type": "public" }` is enough.
 */
function channelSettings(config: PostizConfig, channelId: string, manifest: ProductionPayload): Record<string, unknown> {
  const base = config.channelSettings[channelId] ?? {};
  if ('type' in base && !('title' in base)) {
    return { ...base, title: manifest.topic.hook.slice(0, 100) };
  }
  return base;
}

function recordPublish(entry: PublishLogEntry): void {
  const logEntries = readJsonIfExists<PublishLogEntry[]>(files.publishLog) ?? [];
  logEntries.push(entry);
  writeJson(files.publishLog, logEntries);
}

export async function publishReel(
  manifest: ProductionPayload,
  config: PostizConfig,
  options: PublishOptions = {},
): Promise<PublishResult | null> {
  const channelIds = resolveChannels(manifest, config, 'reel');
  if (channelIds.length === 0) {
    log.warn('no reel channels configured; skipping reel publish');
    return null;
  }
  if (!fs.existsSync(files.finalReel)) throw new Error(`Reel not found: ${files.finalReel}`);

  const scheduledFor = options.scheduledAt ?? manifest.distribution.scheduledTimestamp ?? nextSlot(config, 'reel');
  const caption = buildCaption(manifest);
  log.step(`Publish reel -> ${channelIds.length} channel(s) @ ${scheduledFor}`);

  if (options.dryRun) {
    log.info('dry-run: reel payload', { channelIds, scheduledFor, media: files.finalReel, captionChars: caption.length });
    return { kind: 'reel', channelIds, scheduledFor, postIds: [], dispatchedVia: 'rest' };
  }

  const client = new PostizClient(config);
  let postIds: string[];
  if (config.dispatchMode === 'cli') {
    postIds = await client.createPostViaCli(caption, [files.finalReel], channelIds, scheduledFor);
  } else {
    const media = await client.uploadFile(files.finalReel);
    postIds = await client.createPost({
      type: options.mode ?? 'schedule',
      date: scheduledFor,
      shortLink: false,
      tags: [],
      posts: channelIds.map((id) => ({
        integration: { id },
        value: [{ content: caption, image: [media] }],
        settings: channelSettings(config, id, manifest),
      })),
    });
  }

  const result: PublishResult = { kind: 'reel', channelIds, scheduledFor, postIds, dispatchedVia: config.dispatchMode };
  recordPublish({ runId: manifest.runId, ...result, at: new Date().toISOString() });
  return result;
}

export async function publishCarousel(
  manifest: ProductionPayload,
  config: PostizConfig,
  options: PublishOptions = {},
): Promise<PublishResult | null> {
  const channelIds = resolveChannels(manifest, config, 'carousel');
  if (channelIds.length === 0) {
    log.warn('no carousel channels configured; skipping carousel publish');
    return null;
  }

  const slidePaths = [...manifest.carouselConfig.slides]
    .sort((a, b) => a.index - b.index)
    .map((s) => path.join(paths.carouselOut, `slide_${s.index}.png`));
  const missing = slidePaths.filter((p) => !fs.existsSync(p));
  if (missing.length) throw new Error(`Carousel slides missing: ${missing.join(', ')}`);

  const scheduledFor = options.scheduledAt ?? manifest.distribution.scheduledTimestamp ?? nextSlot(config, 'carousel');
  const caption = buildCaption(manifest);
  log.step(`Publish carousel (${slidePaths.length} slides) -> ${channelIds.length} channel(s) @ ${scheduledFor}`);

  if (options.dryRun) {
    log.info('dry-run: carousel payload', { channelIds, scheduledFor, slides: slidePaths.length, captionChars: caption.length });
    return { kind: 'carousel', channelIds, scheduledFor, postIds: [], dispatchedVia: 'rest' };
  }

  const client = new PostizClient(config);
  let postIds: string[];
  if (config.dispatchMode === 'cli') {
    postIds = await client.createPostViaCli(caption, slidePaths, channelIds, scheduledFor);
  } else {
    // Upload in order; the array order is the carousel order Postiz sends downstream.
    const media: PostizUploadedMedia[] = [];
    for (const p of slidePaths) media.push(await client.uploadFile(p));
    postIds = await client.createPost({
      type: options.mode ?? 'schedule',
      date: scheduledFor,
      shortLink: false,
      tags: [],
      posts: channelIds.map((id) => ({
        integration: { id },
        value: [{ content: caption, image: media }],
        settings: channelSettings(config, id, manifest),
      })),
    });
  }

  const result: PublishResult = { kind: 'carousel', channelIds, scheduledFor, postIds, dispatchedVia: config.dispatchMode };
  recordPublish({ runId: manifest.runId, ...result, at: new Date().toISOString() });
  return result;
}
