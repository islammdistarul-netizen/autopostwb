import fs from 'node:fs';
import { run, which } from '../../lib/shell.ts';
import { log } from '../../lib/log.ts';
import { assertWritable, files, writeJson } from '../../lib/paths.ts';
import { resolveVoicePreset, type AppConfig } from '../../lib/config.ts';
import type { TimedCaptionWord } from '../../types/manifest.ts';
import { getVoiceProvider } from './providers/index.ts';
import { alignWithWhisper } from './align.ts';

/**
 * Voice synthesis front door. Picks the provider from the preset
 * (config.voice.presets[name].provider, default config.voice.provider),
 * normalizes whatever it returns to 16 kHz mono 16-bit PCM WAV, and guarantees
 * per-word captions: from the engine when it has them (edge, elevenlabs),
 * otherwise by whisper alignment against the script text (yandex, piper).
 */

export interface VoiceResult {
  wavPath: string;
  rawAudioPath: string;
  durationSeconds: number;
  provider: string;
  voice: string;
  captions: TimedCaptionWord[];
  captionSource: 'engine' | 'whisper-aligned';
}

export async function assertVoiceTooling(config: AppConfig, presetName?: string): Promise<void> {
  const missing: string[] = [];
  if (!(await which('ffmpeg'))) missing.push('ffmpeg (apt install ffmpeg)');
  if (!(await which('ffprobe'))) missing.push('ffprobe (ships with ffmpeg)');
  if (missing.length) throw new Error(`Voice tooling missing: ${missing.join(', ')}`);
  const preset = resolveVoicePreset(config, presetName);
  await getVoiceProvider(preset.provider ?? config.voice.provider).assertReady();
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
  const providerId = preset.provider ?? config.voice.provider;
  const provider = getVoiceProvider(providerId);
  await provider.assertReady();

  const wavPath = assertWritable(options.wavPath ?? files.voiceWav);
  const captionsPath = assertWritable(options.captionsPath ?? files.captions);
  const outBase = wavPath.replace(/\.wav$/, '.raw');

  log.step(`Voice synthesis: ${providerId} / ${preset.voice}`);
  const output = await provider.synthesize({
    text: narration,
    voice: preset.voice,
    options: preset.options,
    outBase,
  });

  // Normalize to the one format Rhubarb, whisper and Remotion all agree on.
  await run('ffmpeg', [
    '-y',
    '-hide_banner',
    '-loglevel',
    'error',
    ...(output.ffmpegInputArgs ?? []),
    '-i',
    output.audioPath,
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

  let captions: TimedCaptionWord[];
  let captionSource: VoiceResult['captionSource'];
  if (output.captions && output.captions.length > 0) {
    captions = output.captions;
    captionSource = 'engine';
  } else {
    // A stale alignment from the previous run would silently mistime everything.
    const stale = wavPath.replace(/\.wav$/, '.align.json');
    if (fs.existsSync(stale)) fs.unlinkSync(stale);
    log.info('provider has no word timings; aligning with whisper', { model: config.voice.alignModel });
    captions = await alignWithWhisper(narration, wavPath, durationSeconds, config);
    captionSource = 'whisper-aligned';
  }
  writeJson(captionsPath, captions);

  log.info('voice ready', {
    provider: providerId,
    seconds: Number(durationSeconds.toFixed(2)),
    words: captions.length,
    captions: captionSource,
  });
  return { wavPath, rawAudioPath: output.audioPath, durationSeconds, provider: providerId, voice: preset.voice, captions, captionSource };
}
