import fs from 'node:fs';
import path from 'node:path';
import { run, which } from '../../../lib/shell.ts';
import { paths } from '../../../lib/paths.ts';
import { optionNumber, type VoiceOutput, type VoiceProvider, type VoiceRequest } from './types.ts';

/**
 * Piper TTS: fully offline, MIT-licensed, CPU-fast. The only free option that is
 * also legally clean for commercial use. Russian voices sound flatter than
 * edge-tts/Yandex — acceptable for tests and volume, not for a flagship channel.
 *
 * Install: pip3 install piper-tts
 * Voices (put .onnx + .onnx.json into assets/voices/):
 *   ru_RU-irina-medium, ru_RU-denis-medium, ru_RU-dmitri-medium, ru_RU-ruslan-medium
 *   from https://huggingface.co/rhasspy/piper-voices/tree/main/ru/ru_RU
 * No word timings -> whisper alignment.
 */

const VOICES_DIR = path.join(paths.assets, 'voices');
const TIMEOUT_MS = 5 * 60 * 1000;

function modelPath(voice: string): string {
  const direct = voice.endsWith('.onnx') ? voice : `${voice}.onnx`;
  return path.isAbsolute(direct) ? direct : path.join(VOICES_DIR, direct);
}

export const piperProvider: VoiceProvider = {
  id: 'piper',

  async assertReady() {
    if (!(await which('piper'))) throw new Error('piper binary missing: pip3 install piper-tts');
  },

  async synthesize(request: VoiceRequest): Promise<VoiceOutput> {
    const model = modelPath(request.voice);
    if (!fs.existsSync(model) || !fs.existsSync(`${model}.json`)) {
      throw new Error(`Piper voice not found: ${model} (+ .json). Download it into assets/voices/.`);
    }
    const audioPath = `${request.outBase}.wav`;
    await run(
      'piper',
      [
        '--model',
        model,
        '--output_file',
        audioPath,
        '--length_scale',
        String(optionNumber(request.options, 'length_scale', 1.0)),
        '--sentence_silence',
        String(optionNumber(request.options, 'sentence_silence', 0.25)),
      ],
      { input: request.text, timeoutMs: TIMEOUT_MS },
    );
    if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size < 1000) {
      throw new Error('piper produced no audio');
    }
    return { audioPath };
  },
};
