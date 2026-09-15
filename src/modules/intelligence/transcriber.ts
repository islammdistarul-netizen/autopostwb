import fs from 'node:fs';
import path from 'node:path';
import { run, which } from '../../lib/shell.ts';
import { log } from '../../lib/log.ts';
import { paths, writeJson } from '../../lib/paths.ts';
import type { AppConfig } from '../../lib/config.ts';
import type { TimedCaptionWord } from '../../types/manifest.ts';

/**
 * faster-whisper interface for word-level timestamps.
 *
 * Used twice in the pipeline: on competitor audio (to read their hooks) and on
 * our own voice.wav (to time the karaoke captions to the actual synthesized speech
 * instead of an estimate). Both go through scripts/transcribe.py.
 */

export interface Transcript {
  language: string;
  duration: number;
  text: string;
  words: TimedCaptionWord[];
  segments: Array<{ start: number; end: number; text: string }>;
}

const TRANSCRIBE_TIMEOUT_MS = 20 * 60 * 1000;
const SCRIPT = path.join(paths.root, 'scripts', 'transcribe.py');

export async function assertWhisper(): Promise<void> {
  if (!(await which('python3'))) {
    throw new Error('python3 not found.');
  }
  const probe = await run('python3', ['-c', 'import faster_whisper'], { allowFailure: true });
  if (probe.code !== 0) {
    throw new Error('faster-whisper is not installed. Run: pip3 install faster-whisper');
  }
}

export interface TranscribeOptions {
  language?: string;
  model?: string;
  device?: string;
  computeType?: string;
  /** Where to persist the JSON. Defaults to alongside the audio under storage/. */
  outFile?: string;
}

export async function transcribe(
  audioPath: string,
  config: AppConfig,
  options: TranscribeOptions = {},
): Promise<Transcript> {
  if (!fs.existsSync(audioPath)) {
    throw new Error(`Audio not found: ${audioPath}`);
  }

  const outFile = options.outFile ?? audioPath.replace(/\.[^.]+$/, '') + '.transcript.json';
  if (fs.existsSync(outFile)) {
    log.debug('transcript cached', { outFile });
    return JSON.parse(fs.readFileSync(outFile, 'utf8')) as Transcript;
  }

  const args = [
    SCRIPT,
    audioPath,
    '--model',
    options.model ?? config.intelligence.whisperModel,
    '--device',
    options.device ?? config.intelligence.whisperDevice,
    '--compute-type',
    options.computeType ?? config.intelligence.whisperComputeType,
    '--language',
    options.language ?? config.niche.language,
  ];

  log.info('transcribing', { audio: path.basename(audioPath), model: args[3] });
  const result = await run('python3', args, { timeoutMs: TRANSCRIBE_TIMEOUT_MS });

  let transcript: Transcript;
  try {
    transcript = JSON.parse(result.stdout.trim()) as Transcript;
  } catch (err) {
    throw new Error(`transcribe.py produced invalid JSON: ${(err as Error).message}\n${result.stderr.slice(-2000)}`);
  }

  writeJson(outFile, transcript);
  return transcript;
}

/**
 * Convert a transcript into ProductionPayload captions. Word tokens from Whisper
 * sometimes carry leading punctuation; we keep them as-is because the caption
 * renderer draws exactly what was spoken.
 */
export function transcriptToCaptions(transcript: Transcript): TimedCaptionWord[] {
  return transcript.words
    .filter((w) => w.word.trim().length > 0 && w.end >= w.start)
    .map((w) => ({ word: w.word.trim(), start: w.start, end: w.end }));
}

/** YouTube json3 caption format (what `yt-dlp --sub-format json3` writes). */
interface Json3 {
  events?: Array<{
    tStartMs?: number;
    dDurationMs?: number;
    segs?: Array<{ utf8?: string; tOffsetMs?: number }>;
  }>;
}

/**
 * Convert a json3 auto-caption file into the same Transcript shape Whisper
 * yields, so downstream code does not care which source produced it.
 */
export function autoSubsToTranscript(json3Path: string, language: string): Transcript | null {
  let data: Json3;
  try {
    data = JSON.parse(fs.readFileSync(json3Path, 'utf8')) as Json3;
  } catch {
    return null;
  }
  const words: TimedCaptionWord[] = [];
  const segments: Transcript['segments'] = [];

  for (const event of data.events ?? []) {
    if (!event.segs || event.tStartMs === undefined) continue;
    const base = event.tStartMs / 1000;
    const duration = (event.dDurationMs ?? 0) / 1000;
    const tokens = event.segs
      .map((s) => ({ text: (s.utf8 ?? '').replace(/\s+/g, ' ').trim(), offset: (s.tOffsetMs ?? 0) / 1000 }))
      .filter((s) => s.text && s.text !== '\n');
    if (tokens.length === 0) continue;

    tokens.forEach((tok, i) => {
      const start = base + tok.offset;
      const next = tokens[i + 1];
      const end = next ? base + next.offset : base + duration;
      words.push({ word: tok.text, start: +start.toFixed(3), end: +Math.max(end, start + 0.05).toFixed(3) });
    });
    segments.push({ start: base, end: base + duration, text: tokens.map((t) => t.text).join(' ') });
  }

  if (words.length === 0) return null;
  const text = segments.map((s) => s.text).join(' ').trim();
  const last = words[words.length - 1]!;
  const transcript: Transcript = { language, duration: last.end, text, words, segments };
  writeJson(json3Path.replace(/\.[^.]+\.json3$/, '') + '.transcript.json', transcript);
  return transcript;
}
