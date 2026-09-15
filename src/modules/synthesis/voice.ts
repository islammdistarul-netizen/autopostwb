import fs from 'node:fs';
import path from 'node:path';
import { run, which } from '../../lib/shell.ts';
import { log } from '../../lib/log.ts';
import { assertWritable, files, paths, readJson } from '../../lib/paths.ts';
import { resolveVoicePreset, type AppConfig } from '../../lib/config.ts';
import type { TimedCaptionWord } from '../../types/manifest.ts';

/**
 * edge-tts neural voice synthesis (ru-RU-DmitryNeural / ru-RU-SvetlanaNeural).
 *
 * Goes through scripts/tts.py rather than the edge-tts CLI so we get the
 * WordBoundary stream: exact per-word timings for the karaoke captions without a
 * second Whisper pass over our own audio.
 *
 * Output is always normalized to 16 kHz mono 16-bit PCM WAV — the single format
 * Rhubarb, faster-whisper and Remotion's audio layer all agree on.
 */

export interface VoiceResult {
  mp3Path: string;
  wavPath: string;
  durationSeconds: number;
  voice: string;
  /** Word timings straight from the TTS engine. */
  captions: TimedCaptionWord[];
}

const TTS_TIMEOUT_MS = 5 * 60 * 1000;
const TTS_SCRIPT = path.join(paths.root, 'scripts', 'tts.py');

export async function assertVoiceTooling(): Promise<void> {
  const missing: string[] = [];
  if (!(await which('python3'))) missing.push('python3');
  const probe = await run('python3', ['-c', 'import edge_tts'], { allowFailure: true });
  if (probe.code !== 0) missing.push('edge-tts python package (pip3 install edge-tts)');
  if (!(await which('ffmpeg'))) missing.push('ffmpeg (apt install ffmpeg)');
  if (!(await which('ffprobe'))) missing.push('ffprobe (ships with ffmpeg)');
  if (missing.length) throw new Error(`Voice tooling missing: ${missing.join(', ')}`);
}

/** Duration in seconds via ffprobe — the value calculateMetadata() derives frame count from. */
export async function probeDuration(mediaPath: string): Promise<number> {
  const result = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    mediaPath,
  ]);
  const seconds = Number.parseFloat(result.stdout.trim());
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`ffprobe could not read duration of ${mediaPath}: "${result.stdout.trim()}"`);
  }
  return seconds;
}

export interface SynthesizeOptions {
  preset?: string;
  mp3Path?: string;
  wavPath?: string;
  captionsPath?: string;
}

export async function synthesizeVoice(
  text: string,
  config: AppConfig,
  options: SynthesizeOptions = {},
): Promise<VoiceResult> {
  const narration = text.replace(/\s+/g, ' ').trim();
  if (!narration) throw new Error('Cannot synthesize empty narration.');

  const preset = resolveVoicePreset(config, options.preset);
  const mp3Path = assertWritable(options.mp3Path ?? files.voiceMp3);
  const wavPath = assertWritable(options.wavPath ?? files.voiceWav);
  const captionsPath = assertWritable(options.captionsPath ?? files.captions);

  log.step(`Voice synthesis (${preset.voice})`);

  await run(
    'python3',
    [
      TTS_SCRIPT,
      '--text',
      narration,
      '--voice',
      preset.voice,
      '--rate',
      preset.rate,
      '--pitch',
      preset.pitch,
      '--volume',
      preset.volume,
      '--out-audio',
      mp3Path,
      '--out-words',
      captionsPath,
    ],
    { timeoutMs: TTS_TIMEOUT_MS },
  );
  if (!fs.existsSync(mp3Path) || fs.statSync(mp3Path).size === 0) {
    throw new Error('edge-tts finished but produced no audio. Check network access to Microsoft TTS endpoints.');
  }

  // ffmpeg -y -i voice.mp3 -ar 16000 -ac 1 voice.wav (+ explicit 16-bit PCM and loudness normalization)
  await run('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    mp3Path,
    '-af',
    'loudnorm=I=-16:TP=-1.5:LRA=11',
    '-ar',
    String(config.voice.sampleRate),
    '-ac',
    String(config.voice.channels),
    '-c:a',
    'pcm_s16le',
    wavPath,
  ]);

  const durationSeconds = await probeDuration(wavPath);
  const captions = readJson<TimedCaptionWord[]>(captionsPath).filter((w) => w.end > w.start);
  log.info('voice ready', {
    wav: wavPath,
    seconds: Number(durationSeconds.toFixed(2)),
    words: captions.length,
  });

  return { mp3Path, wavPath, durationSeconds, voice: preset.voice, captions };
}
