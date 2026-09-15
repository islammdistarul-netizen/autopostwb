import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Single source of truth for on-disk locations. Every filesystem write in the
 * pipeline goes through here so the storage/ + assets/ boundary from CLAUDE.md
 * is enforced in one place rather than sprinkled across modules.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(here, '..', '..');

export const paths = {
  root: PROJECT_ROOT,
  config: path.join(PROJECT_ROOT, 'config'),
  storage: path.join(PROJECT_ROOT, 'storage'),
  raw: path.join(PROJECT_ROOT, 'storage', 'raw'),
  staged: path.join(PROJECT_ROOT, 'storage', 'staged'),
  artifacts: path.join(PROJECT_ROOT, 'storage', 'artifacts'),
  carouselOut: path.join(PROJECT_ROOT, 'storage', 'artifacts', 'carousel'),
  cache: path.join(PROJECT_ROOT, 'storage', 'cache'),
  assets: path.join(PROJECT_ROOT, 'assets'),
  characters: path.join(PROJECT_ROOT, 'assets', 'characters'),
  bRoll: path.join(PROJECT_ROOT, 'assets', 'b-roll'),
  music: path.join(PROJECT_ROOT, 'assets', 'music'),
  fonts: path.join(PROJECT_ROOT, 'assets', 'fonts'),
} as const;

export const files = {
  appConfig: path.join(paths.config, 'app.config.json'),
  postizConfig: path.join(paths.config, 'postiz.config.json'),
  manifest: path.join(paths.staged, 'manifest.json'),
  voiceMp3: path.join(paths.staged, 'voice.mp3'),
  voiceWav: path.join(paths.staged, 'voice.wav'),
  mouthCues: path.join(paths.staged, 'mouth-cues.json'),
  captions: path.join(paths.staged, 'captions.json'),
  finalReel: path.join(paths.artifacts, 'final_reel.mp4'),
  topics: path.join(paths.raw, 'topics.json'),
  topicHistory: path.join(paths.cache, 'topic-history.json'),
  publishLog: path.join(paths.cache, 'publish-log.json'),
  metricsLog: path.join(paths.cache, 'metrics.jsonl'),
} as const;

const WRITABLE_ROOTS = [paths.storage];

/** Throws when a write would escape storage/ — the pipeline never writes elsewhere. */
export function assertWritable(target: string): string {
  const resolved = path.resolve(target);
  const allowed = WRITABLE_ROOTS.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep),
  );
  if (!allowed) {
    throw new Error(
      `Refusing to write outside storage/: ${resolved}. See CLAUDE.md -> Directory Matrix & Responsibility Boundary.`,
    );
  }
  return resolved;
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureStorageTree(): void {
  for (const dir of [paths.raw, paths.staged, paths.artifacts, paths.carouselOut, paths.cache]) {
    ensureDir(dir);
  }
}

export function writeJson(target: string, data: unknown): string {
  const resolved = assertWritable(target);
  ensureDir(path.dirname(resolved));
  fs.writeFileSync(resolved, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return resolved;
}

export function readJson<T = unknown>(source: string): T {
  return JSON.parse(fs.readFileSync(source, 'utf8')) as T;
}

export function readJsonIfExists<T = unknown>(source: string): T | null {
  if (!fs.existsSync(source)) return null;
  try {
    return readJson<T>(source);
  } catch {
    return null;
  }
}

export function appendJsonl(target: string, record: unknown): void {
  const resolved = assertWritable(target);
  ensureDir(path.dirname(resolved));
  fs.appendFileSync(resolved, JSON.stringify(record) + '\n', 'utf8');
}

export function relativeToRoot(target: string): string {
  return path.relative(PROJECT_ROOT, path.resolve(target)) || '.';
}
