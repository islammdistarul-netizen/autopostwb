import fs from 'node:fs';
import path from 'node:path';
import { log } from '../lib/log.ts';
import { loadAppConfig, loadPostizConfig } from '../lib/config.ts';
import {
  assertWritable,
  ensureDir,
  ensureStorageTree,
  files,
  paths,
  readJson,
  readJsonIfExists,
  relativeToRoot,
  writeJson,
} from '../lib/paths.ts';
import { run } from '../lib/shell.ts';
import { assertManifest, type ProductionPayload } from '../types/manifest.ts';
import { loadTopicHistory, recordTopicUsage, runIntelligence, type TopicCandidate, type TopicsFile } from '../modules/intelligence/analyzer.ts';
import { buildTimeline, compileManifest, writeScript } from '../modules/scripting/scriptwriter.ts';
import { synthesizeVoice } from '../modules/synthesis/voice.ts';
import { generateMouthCues } from '../modules/synthesis/lipsync.ts';
import { compileCarousel } from '../modules/carousel/compiler.ts';
import { publishCarousel, publishReel } from '../modules/distribution/publisher.ts';
import type { PublishResult } from '../types/postiz.ts';

/**
 * Deterministic step-by-step pipeline coordinator.
 *
 * Each step reads its inputs from storage/ and writes its outputs there, so any
 * step can be re-run in isolation and a crashed run resumes from disk. A lock
 * file keeps overlapping cron invocations from trampling storage/staged.
 */

const LOCK_FILE = path.join(paths.cache, 'pipeline.lock');
const PUBLIC_DIR = path.join(paths.staged, 'public');

export interface ProduceOptions {
  topicId?: string;
  characterId?: string;
  skipRender?: boolean;
  skipCarousel?: boolean;
  /** Reuse voice.wav / mouth-cues.json already in storage/staged. */
  reuseAudio?: boolean;
}

export interface RunSummary {
  runId: string;
  topicId: string;
  hook: string;
  durationSeconds: number;
  reel: string | null;
  slides: string[];
  producedAt: string;
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

export function acquireLock(): () => void {
  ensureDir(paths.cache);
  if (fs.existsSync(LOCK_FILE)) {
    const info = readJsonIfExists<{ pid: number; at: string }>(LOCK_FILE);
    const alive = info?.pid ? isProcessAlive(info.pid) : false;
    if (alive) throw new Error(`Pipeline already running (pid ${info?.pid}, since ${info?.at}). Lock: ${LOCK_FILE}`);
    log.warn('stale lock removed', { pid: info?.pid });
  }
  writeJson(LOCK_FILE, { pid: process.pid, at: new Date().toISOString() });
  const release = () => {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  };
  process.once('exit', release);
  return release;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Step 1
// ---------------------------------------------------------------------------

export async function stepIntelligence(options: { reuseScrape?: boolean; transcribeTopN?: number } = {}): Promise<TopicsFile> {
  ensureStorageTree();
  return runIntelligence(loadAppConfig(), options);
}

export function pickTopic(topicId?: string): TopicCandidate {
  const topics = readJsonIfExists<TopicsFile>(files.topics);
  if (!topics || topics.candidates.length === 0) {
    throw new Error(`No topics at ${relativeToRoot(files.topics)}. Run \`npm run intel\` first.`);
  }
  if (topicId) {
    const found = topics.candidates.find((c) => c.id === topicId);
    if (!found) throw new Error(`Topic ${topicId} not found in topics.json`);
    return found;
  }
  const used = new Set(loadTopicHistory(loadAppConfig().intelligence.topicHistoryWindowDays).map((h) => h.topicId));
  const fresh = topics.candidates.find((c) => !used.has(c.id));
  if (!fresh) throw new Error('Every candidate topic was already used in the history window. Re-run intel.');
  return fresh;
}

// ---------------------------------------------------------------------------
// Steps 2-5
// ---------------------------------------------------------------------------

function newRunId(): string {
  const now = new Date();
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  return `run-${stamp}`;
}

/** Mirror everything Remotion needs into storage/staged/public (the Remotion public dir). */
export function stageRemotionPublicDir(manifest: ProductionPayload): void {
  const pub = assertWritable(PUBLIC_DIR);
  fs.rmSync(pub, { recursive: true, force: true });
  ensureDir(pub);

  const copy = (src: string, dest: string) => {
    if (!fs.existsSync(src)) throw new Error(`Required asset missing: ${src}`);
    ensureDir(path.dirname(dest));
    fs.cpSync(src, dest, { recursive: true });
  };

  copy(files.voiceWav, path.join(pub, 'voice.wav'));
  copy(files.mouthCues, path.join(pub, 'mouth-cues.json'));
  copy(path.join(paths.characters, manifest.videoConfig.characterId), path.join(pub, 'assets', 'characters', manifest.videoConfig.characterId));
  copy(path.join(paths.bRoll, manifest.videoConfig.bRollAsset), path.join(pub, 'assets', 'b-roll', manifest.videoConfig.bRollAsset));
  copy(path.join(paths.music, manifest.videoConfig.musicTrack), path.join(pub, 'assets', 'music', manifest.videoConfig.musicTrack));
  copy(paths.fonts, path.join(pub, 'assets', 'fonts'));
}

export async function renderReel(config = loadAppConfig()): Promise<string> {
  const gl = process.env.CF_GL_RENDERER ?? config.video.glRenderer;
  log.step(`Remotion render (concurrency=${config.video.concurrency}, gl=${gl})`);
  const out = assertWritable(files.finalReel);
  const args = [
    'remotion',
    'render',
    'src/modules/video/Root.tsx',
    'ReelComposition',
    out,
    `--props=${files.manifest}`,
    `--concurrency=${config.video.concurrency}`,
    `--gl=${gl}`,
    `--public-dir=${PUBLIC_DIR}`,
    '--codec=h264',
    '--log=warn',
  ];
  // Servers whose egress blocks remotion.media can point at a system Chromium instead.
  if (process.env.CF_BROWSER_EXECUTABLE) args.push(`--browser-executable=${process.env.CF_BROWSER_EXECUTABLE}`);
  await run('npx', args, { cwd: paths.root, stream: true, timeoutMs: config.video.maxRenderSeconds * 1000 });
  if (!fs.existsSync(out)) throw new Error('Remotion exited 0 but final_reel.mp4 is missing');
  return out;
}

export async function stepProduce(options: ProduceOptions = {}): Promise<RunSummary> {
  const config = loadAppConfig();
  ensureStorageTree();

  const topic = pickTopic(options.topicId);
  const runId = newRunId();
  const targetDate = new Date().toISOString().slice(0, 10);
  log.step(`Produce ${runId} <- topic ${topic.id} (${topic.hookType})`);

  // Step 2: script -> manifest (captions are estimates until TTS reports real timings)
  const draft = await writeScript(topic, config);
  let { manifest } = compileManifest(draft, topic, config, { runId, targetDate, characterId: options.characterId });
  manifest = assertManifest(manifest);
  writeJson(files.manifest, manifest);

  // Step 3: voice + acoustic lipsync
  if (!options.reuseAudio || !fs.existsSync(files.voiceWav)) {
    const voice = await synthesizeVoice(manifest.script.fullText, config);
    const totalFrames = Math.ceil(voice.durationSeconds * config.video.fps);
    manifest = assertManifest({
      ...manifest,
      script: {
        ...manifest.script,
        estimatedDuration: Number(voice.durationSeconds.toFixed(2)),
        captions: voice.captions,
      },
      videoConfig: {
        ...manifest.videoConfig,
        timeline: buildTimeline(draft.segments, voice.captions, config.video.fps, totalFrames),
      },
    });
    writeJson(files.manifest, manifest);
    await generateMouthCues({ dialogText: manifest.script.fullText });
  } else {
    log.info('reusing staged voice.wav / mouth-cues.json');
    if (!fs.existsSync(files.mouthCues)) await generateMouthCues({ dialogText: manifest.script.fullText });
  }

  // Step 4: reel
  let reel: string | null = null;
  if (!options.skipRender) {
    stageRemotionPublicDir(manifest);
    reel = await renderReel(config);
  }

  // Step 5: carousel
  let slides: string[] = [];
  if (!options.skipCarousel) {
    slides = (await compileCarousel(manifest, config, { brandHandle: process.env.CF_BRAND_HANDLE ?? '' })).map((s) => s.pngPath);
  }

  recordTopicUsage({ topicId: topic.id, hook: topic.hook, keywords: topic.keywords, usedAt: new Date().toISOString(), runId });

  const summary: RunSummary = {
    runId,
    topicId: topic.id,
    hook: manifest.topic.hook,
    durationSeconds: manifest.script.estimatedDuration,
    reel,
    slides,
    producedAt: new Date().toISOString(),
  };
  writeJson(path.join(paths.artifacts, 'run.json'), summary);
  archiveRun(manifest, summary, config);
  log.info('produce complete', { runId, reel: reel ? relativeToRoot(reel) : null, slides: slides.length });
  return summary;
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

const RUNS_DIR = path.join(paths.artifacts, 'runs');

/**
 * storage/artifacts/final_reel.mp4 and carousel/ are overwritten by every run
 * (that is what Postiz reads). A copy of each run — manifest, voice, cues, reel,
 * slides — lands in storage/artifacts/runs/<runId>/ so a bad post can be traced
 * back and re-published, then old runs and stale raw scrapes are pruned.
 */
export function archiveRun(manifest: ProductionPayload, summary: RunSummary, config = loadAppConfig()): string {
  const dir = ensureDir(assertWritable(path.join(RUNS_DIR, summary.runId)));
  const copy = (src: string | null, name: string) => {
    if (src && fs.existsSync(src)) fs.copyFileSync(src, path.join(dir, name));
  };
  writeJson(path.join(dir, 'manifest.json'), manifest);
  writeJson(path.join(dir, 'run.json'), summary);
  copy(files.voiceWav, 'voice.wav');
  copy(files.mouthCues, 'mouth-cues.json');
  copy(files.captions, 'captions.json');
  copy(summary.reel, 'final_reel.mp4');
  for (const slide of summary.slides) copy(slide, path.basename(slide));

  pruneRuns(config.retention.keepRuns);
  pruneRaw(config.retention.rawDays);
  return dir;
}

function pruneRuns(keep: number): void {
  if (!fs.existsSync(RUNS_DIR)) return;
  const runs = fs
    .readdirSync(RUNS_DIR)
    .filter((n) => n.startsWith('run-'))
    .sort(); // runId embeds a UTC timestamp, so lexical order == chronological
  for (const stale of runs.slice(0, Math.max(0, runs.length - keep))) {
    fs.rmSync(assertWritable(path.join(RUNS_DIR, stale)), { recursive: true, force: true });
    log.debug('pruned run', { runId: stale });
  }
}

function pruneRaw(days: number): void {
  const cutoff = Date.now() - days * 86_400_000;
  for (const sub of ['audio', 'subs']) {
    const dir = path.join(paths.raw, sub);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(assertWritable(file), { force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// Step 6
// ---------------------------------------------------------------------------

export async function stepPublish(options: { dryRun?: boolean; mode?: 'draft' | 'schedule' | 'now' } = {}): Promise<PublishResult[]> {
  const manifest = assertManifest(readJson(files.manifest));
  const postiz = loadPostizConfig();
  const results: PublishResult[] = [];
  const reel = await publishReel(manifest, postiz, options);
  if (reel) results.push(reel);
  const carousel = await publishCarousel(manifest, postiz, options);
  if (carousel) results.push(carousel);
  return results;
}

export async function runFullPipeline(options: ProduceOptions & { dryRun?: boolean; reuseScrape?: boolean } = {}): Promise<{
  summary: RunSummary;
  published: PublishResult[];
}> {
  const release = acquireLock();
  try {
    await stepIntelligence({ reuseScrape: options.reuseScrape });
    const summary = await stepProduce(options);
    const published = await stepPublish({ dryRun: options.dryRun });
    return { summary, published };
  } finally {
    release();
  }
}
