import { log } from '../../lib/log.ts';
import type { AppConfig } from '../../lib/config.ts';
import type { TimedCaptionWord } from '../../types/manifest.ts';
import { transcribe } from '../intelligence/transcriber.ts';

/**
 * Forced alignment for providers that do not report word timings (Yandex,
 * Piper). faster-whisper transcribes our own voice.wav, then the *known* script
 * words are matched to whisper's words with a Needleman–Wunsch alignment, so
 * the captions keep the script's exact spelling/punctuation while borrowing
 * whisper's timestamps. Unmatched script words are interpolated between their
 * matched neighbours.
 */

function normalize(token: string): string {
  return token.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '').replace(/ё/g, 'е');
}

/** 0..1 similarity based on Levenshtein distance; cheap for word-sized strings. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j]!;
  }
  return 1 - prev[b.length]! / Math.max(a.length, b.length);
}

const MATCH_THRESHOLD = 0.6;
const GAP = -0.4;

/**
 * Align script tokens to recognized words. Returns, per script token, the index
 * of the matched recognized word or -1.
 */
export function alignTokens(script: string[], recognized: string[]): number[] {
  const n = script.length;
  const m = recognized.length;
  const s = script.map(normalize);
  const r = recognized.map(normalize);

  // dp[i][j] = best score aligning first i script tokens with first j recognized words
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 1; i <= n; i += 1) dp[i]![0] = i * GAP;
  for (let j = 1; j <= m; j += 1) dp[0]![j] = j * GAP;
  for (let i = 1; i <= n; i += 1) {
    for (let j = 1; j <= m; j += 1) {
      const sim = similarity(s[i - 1]!, r[j - 1]!);
      const matchScore = sim >= MATCH_THRESHOLD ? sim : -1;
      dp[i]![j] = Math.max(dp[i - 1]![j - 1]! + matchScore, dp[i - 1]![j]! + GAP, dp[i]![j - 1]! + GAP);
    }
  }

  const result = new Array<number>(n).fill(-1);
  let i = n;
  let j = m;
  while (i > 0 && j > 0) {
    const sim = similarity(s[i - 1]!, r[j - 1]!);
    const matchScore = sim >= MATCH_THRESHOLD ? sim : -1;
    if (dp[i]![j] === dp[i - 1]![j - 1]! + matchScore) {
      if (sim >= MATCH_THRESHOLD) result[i - 1] = j - 1;
      i -= 1;
      j -= 1;
    } else if (dp[i]![j] === dp[i - 1]![j]! + GAP) {
      i -= 1;
    } else {
      j -= 1;
    }
  }
  return result;
}

/** Build captions for `text` using recognized words with timings. */
export function captionsFromAlignment(text: string, recognized: TimedCaptionWord[], totalDuration: number): TimedCaptionWord[] {
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  if (recognized.length === 0) {
    const step = totalDuration / tokens.length;
    return tokens.map((word, k) => ({ word, start: +(k * step).toFixed(3), end: +((k + 1) * step).toFixed(3) }));
  }

  const matches = alignTokens(tokens, recognized.map((w) => w.word));
  const starts = new Array<number>(tokens.length).fill(NaN);
  const ends = new Array<number>(tokens.length).fill(NaN);
  matches.forEach((m, k) => {
    if (m >= 0) {
      starts[k] = recognized[m]!.start;
      ends[k] = recognized[m]!.end;
    }
  });

  // Interpolate gaps: distribute the span between the surrounding matched words by character count.
  let k = 0;
  while (k < tokens.length) {
    if (!Number.isNaN(starts[k])) {
      k += 1;
      continue;
    }
    let gapEnd = k;
    while (gapEnd < tokens.length && Number.isNaN(starts[gapEnd])) gapEnd += 1;
    const spanStart = k === 0 ? 0 : ends[k - 1]!;
    const spanEnd = gapEnd < tokens.length ? starts[gapEnd]! : totalDuration;
    const chars = tokens.slice(k, gapEnd).map((t) => t.length);
    const total = chars.reduce((a, b) => a + b, 0) || 1;
    let cursor = spanStart;
    for (let g = k; g < gapEnd; g += 1) {
      const share = (chars[g - k]! / total) * Math.max(0, spanEnd - spanStart);
      starts[g] = cursor;
      ends[g] = cursor + share;
      cursor += share;
    }
    k = gapEnd;
  }

  // Enforce monotonic, non-zero durations.
  const captions: TimedCaptionWord[] = [];
  let last = 0;
  tokens.forEach((word, idx) => {
    const start = Math.max(last, starts[idx]!);
    const end = Math.max(start + 0.03, ends[idx]!);
    captions.push({ word, start: +start.toFixed(3), end: +end.toFixed(3) });
    last = end;
  });
  const matched = matches.filter((m) => m >= 0).length;
  log.info('captions aligned', { words: tokens.length, matched, interpolated: tokens.length - matched });
  return captions;
}

export async function alignWithWhisper(text: string, wavPath: string, durationSeconds: number, config: AppConfig): Promise<TimedCaptionWord[]> {
  const transcript = await transcribe(wavPath, config, {
    model: config.voice.alignModel,
    outFile: wavPath.replace(/\.wav$/, '.align.json'),
  });
  return captionsFromAlignment(text, transcript.words, durationSeconds);
}
