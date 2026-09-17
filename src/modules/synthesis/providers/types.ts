import type { TimedCaptionWord } from '../../../types/manifest.ts';

/**
 * Pluggable TTS providers. Each one turns narration into an audio file; the
 * ones that can also report per-word timings do so, the rest leave `captions`
 * undefined and voice.ts aligns the known script text against the audio with
 * faster-whisper instead. Downstream code never sees the difference.
 */

export interface VoiceRequest {
  text: string;
  /** Provider-specific voice id (ru-RU-DmitryNeural, alena, ru_RU-irina-medium, an ElevenLabs id...). */
  voice: string;
  /** Free-form provider options from config (rate, pitch, speed, emotion, model...). */
  options: Record<string, string | number | boolean>;
  /** Where to write the raw provider output (extension chosen by the provider). */
  outBase: string;
}

export interface VoiceOutput {
  /** Path to the audio the provider produced (mp3/wav/ogg/raw). */
  audioPath: string;
  /** ffmpeg input flags when the file is headerless (e.g. Yandex lpcm). */
  ffmpegInputArgs?: string[];
  /** Word timings straight from the engine, when it has them. */
  captions?: TimedCaptionWord[];
}

export interface VoiceProvider {
  readonly id: string;
  /** Throws with an actionable message when the provider cannot run here. */
  assertReady(): Promise<void>;
  synthesize(request: VoiceRequest): Promise<VoiceOutput>;
}

export function optionString(options: VoiceRequest['options'], key: string, fallback: string): string {
  const v = options[key];
  return v === undefined ? fallback : String(v);
}

export function optionNumber(options: VoiceRequest['options'], key: string, fallback: number): number {
  const v = Number(options[key]);
  return Number.isFinite(v) ? v : fallback;
}
