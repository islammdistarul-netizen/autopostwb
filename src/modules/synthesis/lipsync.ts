import fs from 'node:fs';
import { run, which } from '../../lib/shell.ts';
import { log } from '../../lib/log.ts';
import { assertWritable, files, readJson } from '../../lib/paths.ts';
import { MouthCuesSchema, type MouthCues } from '../../types/manifest.ts';

/**
 * Rhubarb Lip Sync execution for Russian speech.
 *
 * Rhubarb ships two recognizers: `pocketSphinx` (default, English-only word
 * models — stalls on Russian phonetics) and `phonetic` (language-independent,
 * works on raw sounds/syllables). The original spec called the second one
 * `-r sound`; that value does not exist in Rhubarb 1.x and the binary rejects it.
 * `-r phonetic` is the acoustic mode the spec intends.
 */

export const RHUBARB_RECOGNIZER = 'phonetic' as const;
const RHUBARB_TIMEOUT_MS = 10 * 60 * 1000;

export async function assertRhubarb(): Promise<void> {
  if (!(await which('rhubarb'))) {
    throw new Error(
      'rhubarb not found. Run scripts/setup-server.sh (downloads Rhubarb Lip Sync into /usr/local/bin).',
    );
  }
}

export interface LipsyncOptions {
  wavPath?: string;
  outPath?: string;
  /** Plain-text narration; improves the phonetic recognizer's timing slightly. */
  dialogText?: string;
}

export async function generateMouthCues(options: LipsyncOptions = {}): Promise<MouthCues> {
  const wavPath = options.wavPath ?? files.voiceWav;
  const outPath = assertWritable(options.outPath ?? files.mouthCues);
  if (!fs.existsSync(wavPath)) throw new Error(`voice.wav not found at ${wavPath}`);

  log.step('Lip sync (rhubarb -r phonetic)');

  // --extendedShapes X: only emit A-F + X, which is exactly the registered sprite set;
  // G/H would otherwise need to be collapsed onto neighbours at render time.
  const args = ['-r', RHUBARB_RECOGNIZER, '-f', 'json', '--machineReadable', '--extendedShapes', 'X', '-o', outPath];
  let dialogFile: string | null = null;
  if (options.dialogText) {
    dialogFile = assertWritable(outPath.replace(/\.json$/, '.dialog.txt'));
    fs.writeFileSync(dialogFile, options.dialogText, 'utf8');
    args.push('-d', dialogFile);
  }
  args.push(wavPath);

  await run('rhubarb', args, { timeoutMs: RHUBARB_TIMEOUT_MS });

  const parsed = MouthCuesSchema.safeParse(readJson(outPath));
  if (!parsed.success) {
    throw new Error(`Rhubarb output at ${outPath} is not valid mouth-cues JSON: ${parsed.error.message}`);
  }

  log.info('mouth cues ready', { cues: parsed.data.mouthCues.length });
  return parsed.data;
}
