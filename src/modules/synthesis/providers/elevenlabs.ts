import fs from 'node:fs';
import type { TimedCaptionWord } from '../../../types/manifest.ts';
import { optionString, type VoiceOutput, type VoiceProvider, type VoiceRequest } from './types.ts';

/**
 * ElevenLabs text-to-speech with character-level timestamps (premium tier).
 * Best quality and voice cloning; returns alignment data, so no whisper pass.
 *
 * Env: ELEVENLABS_API_KEY. `voice` is the ElevenLabs voice id.
 * Docs: https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps
 */

const BASE = 'https://api.elevenlabs.io/v1';

interface WithTimestampsResponse {
  audio_base64: string;
  alignment?: {
    characters: string[];
    character_start_times_seconds: number[];
    character_end_times_seconds: number[];
  } | null;
}

/** Group character timings into words at whitespace boundaries. */
export function alignmentToWords(alignment: NonNullable<WithTimestampsResponse['alignment']>): TimedCaptionWord[] {
  const words: TimedCaptionWord[] = [];
  let current = '';
  let start = 0;
  let end = 0;
  alignment.characters.forEach((ch, i) => {
    const s = alignment.character_start_times_seconds[i] ?? end;
    const e = alignment.character_end_times_seconds[i] ?? s;
    if (/\s/.test(ch)) {
      if (current) words.push({ word: current, start, end });
      current = '';
      return;
    }
    if (!current) start = s;
    current += ch;
    end = e;
  });
  if (current) words.push({ word: current, start, end });
  return words.map((w) => ({ ...w, start: +w.start.toFixed(3), end: +Math.max(w.end, w.start + 0.03).toFixed(3) }));
}

export const elevenlabsProvider: VoiceProvider = {
  id: 'elevenlabs',

  async assertReady() {
    if (!process.env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is not set.');
  },

  async synthesize(request: VoiceRequest): Promise<VoiceOutput> {
    const model = optionString(request.options, 'model', 'eleven_multilingual_v2');
    const res = await fetch(`${BASE}/text-to-speech/${encodeURIComponent(request.voice)}/with-timestamps?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY!, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: request.text,
        model_id: model,
        voice_settings: {
          stability: Number(request.options.stability ?? 0.5),
          similarity_boost: Number(request.options.similarity_boost ?? 0.75),
          style: Number(request.options.style ?? 0.2),
        },
      }),
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${(await res.text()).slice(0, 500)}`);
    const data = (await res.json()) as WithTimestampsResponse;

    const audioPath = `${request.outBase}.mp3`;
    fs.writeFileSync(audioPath, Buffer.from(data.audio_base64, 'base64'));
    const captions = data.alignment ? alignmentToWords(data.alignment) : undefined;
    return { audioPath, captions: captions && captions.length ? captions : undefined };
  },
};
