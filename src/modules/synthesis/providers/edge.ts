import fs from 'node:fs';
import path from 'node:path';
import { run } from '../../../lib/shell.ts';
import { paths, readJson } from '../../../lib/paths.ts';
import type { TimedCaptionWord } from '../../../types/manifest.ts';
import { optionString, type VoiceOutput, type VoiceProvider, type VoiceRequest } from './types.ts';

/**
 * edge-tts (Microsoft neural voices) through scripts/tts.py, which streams
 * WordBoundary events -> exact per-word timings. Free; unofficial endpoint.
 */

const TTS_SCRIPT = path.join(paths.root, 'scripts', 'tts.py');
const TIMEOUT_MS = 5 * 60 * 1000;

export const edgeProvider: VoiceProvider = {
  id: 'edge',

  async assertReady() {
    const probe = await run('python3', ['-c', 'import edge_tts'], { allowFailure: true });
    if (probe.code !== 0) throw new Error('edge-tts python package missing: pip3 install edge-tts');
  },

  async synthesize(request: VoiceRequest): Promise<VoiceOutput> {
    const audioPath = `${request.outBase}.mp3`;
    const wordsPath = `${request.outBase}.words.json`;
    await run(
      'python3',
      [
        TTS_SCRIPT,
        '--text',
        request.text,
        '--voice',
        request.voice,
        '--rate',
        optionString(request.options, 'rate', '+0%'),
        '--pitch',
        optionString(request.options, 'pitch', '+0Hz'),
        '--volume',
        optionString(request.options, 'volume', '+0%'),
        '--out-audio',
        audioPath,
        '--out-words',
        wordsPath,
      ],
      { timeoutMs: TIMEOUT_MS },
    );
    if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size === 0) {
      throw new Error('edge-tts produced no audio. Check network access to Microsoft TTS endpoints.');
    }
    const captions = readJson<TimedCaptionWord[]>(wordsPath).filter((w) => w.end > w.start);
    return { audioPath, captions: captions.length ? captions : undefined };
  },
};
