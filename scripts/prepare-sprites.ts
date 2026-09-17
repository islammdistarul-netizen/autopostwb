/**
 * Turn raw art into a registered sprite (background removal, trim, fit, guides).
 *
 *   npx tsx scripts/prepare-sprites.ts <characterId> <input.png> --pose pointing [--mood happy] [--keep-bg]
 *   npx tsx scripts/prepare-sprites.ts <characterId> --approve --pose pointing [--mood happy]
 *   npx tsx scripts/prepare-sprites.ts <characterId> --requests        # poses the scriptwriter asked for
 *
 * Look at storage/cache/sprite-candidates/<id>/<pose>.preview.png before --approve:
 * the red crosshair is where the mouth overlay lands, blue is the face overlay.
 * Adjust layers.mouths.offset in character.json if the art needs it.
 */
import { emitPayload, log } from '../src/lib/log.ts';
import { listSpriteRequests, prepareSprite, registerSprite } from '../src/modules/avatar/sprites.ts';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function main(): Promise<void> {
  const positional = process.argv.slice(2).filter((a, i, arr) => !a.startsWith('--') && !(arr[i - 1] ?? '').startsWith('--'));
  const characterId = positional[0];
  if (!characterId) throw new Error('usage: prepare-sprites.ts <characterId> [input] --pose <pose> [--mood <mood>] [--approve] [--requests]');

  if (has('requests')) {
    emitPayload(listSpriteRequests(characterId));
    return;
  }

  const pose = flag('pose');
  if (!pose) throw new Error('--pose is required');
  const mood = flag('mood');

  if (has('approve')) {
    const { installedPath } = registerSprite({ characterId, pose, mood, candidatePath: flag('candidate') });
    log.info('installed', { installedPath });
    return;
  }

  const input = positional[1];
  if (!input) throw new Error('input image path is required (or use --approve)');
  const result = await prepareSprite({
    characterId,
    input,
    pose,
    mood,
    removeBackground: has('keep-bg') ? false : 'auto',
    rembgModel: flag('rembg-model'),
  });
  emitPayload(result);
}

main().catch((err: Error) => {
  log.error(err.message);
  process.exitCode = 1;
});
