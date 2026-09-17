import fs from 'node:fs';
import { optionNumber, optionString, type VoiceOutput, type VoiceProvider, type VoiceRequest } from './types.ts';

/**
 * Yandex SpeechKit TTS (REST v1). Excellent Russian prosody, ~1 RUB per reel.
 * No word timings -> voice.ts aligns the script text with faster-whisper.
 *
 * Env: YANDEX_API_KEY (service-account API key with ai.speechkit-tts.user role),
 *      YANDEX_FOLDER_ID (folder the key belongs to).
 * Voices: alena, filipp, jane, omazh, zahar, ermil, marina, alexander, kirill,
 *         anton, dasha, julia, lera, masha (emotions: neutral | good | evil, voice-dependent).
 * Docs: https://yandex.cloud/docs/speechkit/tts/request
 */

const ENDPOINT = 'https://tts.api.cloud.yandex.net/speech/v1/tts:synthesize';
const MAX_CHARS = 5000;
const SAMPLE_RATE = 48000;

export const yandexProvider: VoiceProvider = {
  id: 'yandex',

  async assertReady() {
    if (!process.env.YANDEX_API_KEY) {
      throw new Error('YANDEX_API_KEY is not set (Yandex Cloud -> service account -> API key, role ai.speechkit-tts.user).');
    }
  },

  async synthesize(request: VoiceRequest): Promise<VoiceOutput> {
    if (request.text.length > MAX_CHARS) {
      throw new Error(`Yandex TTS accepts up to ${MAX_CHARS} characters per request; narration is ${request.text.length}.`);
    }
    const form = new URLSearchParams();
    form.set('text', request.text);
    form.set('lang', optionString(request.options, 'lang', 'ru-RU'));
    form.set('voice', request.voice);
    form.set('speed', String(optionNumber(request.options, 'speed', 1.0)));
    form.set('format', 'lpcm');
    form.set('sampleRateHertz', String(SAMPLE_RATE));
    const emotion = optionString(request.options, 'emotion', '');
    if (emotion) form.set('emotion', emotion);
    if (process.env.YANDEX_FOLDER_ID) form.set('folderId', process.env.YANDEX_FOLDER_ID);

    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Api-Key ${process.env.YANDEX_API_KEY}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    if (!res.ok) {
      throw new Error(`Yandex TTS ${res.status}: ${(await res.text()).slice(0, 500)}`);
    }
    const audioPath = `${request.outBase}.pcm`;
    fs.writeFileSync(audioPath, Buffer.from(await res.arrayBuffer()));
    if (fs.statSync(audioPath).size < 1000) throw new Error('Yandex TTS returned an empty audio stream.');

    // lpcm is headerless 16-bit mono; tell ffmpeg what it is.
    return { audioPath, ffmpegInputArgs: ['-f', 's16le', '-ar', String(SAMPLE_RATE), '-ac', '1'] };
  },
};
