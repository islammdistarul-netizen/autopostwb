/**
 * Generate a missing pose / pose×mood frame for a character, on-model, then run
 * it through the prepare pipeline. Human-gated: nothing is registered until
 * `prepare-sprites.ts --approve` (or `--approve` here after eyeballing the preview).
 *
 *   npx tsx scripts/generate-sprite.ts <characterId> --pose holding_laptop [--mood happy] [--prompt "..."] [--approve]
 *   npx tsx scripts/generate-sprite.ts <characterId> --from-requests           # everything the scriptwriter asked for
 *
 * Backends (CF_SPRITE_BACKEND): openai (gpt-image-1 edits, transparent PNG out) | gemini (gemini-2.5-flash-image).
 * Both receive character.generation.reference as the identity anchor. Never called from the render loop.
 */
import fs from 'node:fs';
import path from 'node:path';
import { emitPayload, log } from '../src/lib/log.ts';
import { ensureDir, paths } from '../src/lib/paths.ts';
import { characterDir, listSpriteRequests, loadCharacter, prepareSprite, registerSprite } from '../src/modules/avatar/sprites.ts';
import type { CharacterDefinition } from '../src/types/avatar.ts';

type Backend = 'openai' | 'gemini';

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

function buildPrompt(def: CharacterDefinition, pose: string, mood: string | undefined, extra: string | undefined): string {
  const gen = def.generation!;
  const poseText = gen.posePrompts[pose] ?? `body pose: ${pose.replace(/_/g, ' ')}`;
  const moodText = mood ? (gen.moodPrompts[mood] ?? `facial expression: ${mood.replace(/_/g, ' ')}`) : 'neutral facial expression, mouth closed';
  return [
    'Same character as the reference image, identical face, hair, outfit, colors and proportions.',
    gen.stylePrompt,
    poseText,
    moodText,
    'Waist-up, facing the camera at three-quarter angle, centered, full head and both hands inside the frame.',
    'Mouth closed. Plain solid white background, no shadows on the background, no text, no watermark.',
    extra ?? '',
  ]
    .filter(Boolean)
    .join(' ');
}

async function generateOpenAI(referencePath: string, prompt: string): Promise<Buffer> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY is not set');
  const form = new FormData();
  form.append('model', 'gpt-image-1');
  form.append('prompt', prompt);
  form.append('size', '1024x1536');
  form.append('quality', 'high');
  form.append('background', 'transparent');
  form.append('image[]', new Blob([fs.readFileSync(referencePath)], { type: 'image/png' }), path.basename(referencePath));
  const res = await fetch('https://api.openai.com/v1/images/edits', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form });
  if (!res.ok) throw new Error(`OpenAI images ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = (await res.json()) as { data?: Array<{ b64_json?: string }> };
  const b64 = data.data?.[0]?.b64_json;
  if (!b64) throw new Error('OpenAI returned no image data');
  return Buffer.from(b64, 'base64');
}

async function generateGemini(referencePath: string, prompt: string): Promise<Buffer> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY is not set');
  const model = process.env.CF_GEMINI_IMAGE_MODEL ?? 'gemini-2.5-flash-image';
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            { inline_data: { mime_type: 'image/png', data: fs.readFileSync(referencePath).toString('base64') } },
            { text: prompt },
          ],
        },
      ],
      generationConfig: { responseModalities: ['IMAGE'] },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}: ${(await res.text()).slice(0, 500)}`);
  const data = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }> };
  const b64 = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
  if (!b64) throw new Error('Gemini returned no image part');
  return Buffer.from(b64, 'base64');
}

async function generateOne(def: CharacterDefinition, pose: string, mood: string | undefined, extra: string | undefined, approve: boolean) {
  if (!def.generation) {
    throw new Error(`character "${def.id}" has no "generation" block (reference + stylePrompt) in character.json`);
  }
  const referencePath = path.join(characterDir(def.id), def.generation.reference);
  if (!fs.existsSync(referencePath)) throw new Error(`reference image missing: ${referencePath}`);

  const backend = (process.env.CF_SPRITE_BACKEND ?? 'openai') as Backend;
  const prompt = buildPrompt(def, pose, mood, extra);
  log.step(`generate ${pose}${mood ? '/' + mood : ''} via ${backend}`);
  const png = backend === 'gemini' ? await generateGemini(referencePath, prompt) : await generateOpenAI(referencePath, prompt);

  const rawDir = ensureDir(path.join(paths.cache, 'sprite-raw', def.id));
  const rawPath = path.join(rawDir, `${pose}${mood ? '__' + mood : ''}.${Date.now()}.png`);
  fs.writeFileSync(rawPath, png);

  const prepared = await prepareSprite({ characterId: def.id, input: rawPath, pose, mood, removeBackground: 'auto' });
  if (approve) registerSprite({ characterId: def.id, pose, mood, candidatePath: prepared.candidatePath });
  return { pose, mood, backend, rawPath, ...prepared, registered: approve };
}

async function main(): Promise<void> {
  const characterId = process.argv.slice(2).find((a) => !a.startsWith('--'));
  if (!characterId) throw new Error('usage: generate-sprite.ts <characterId> --pose <pose> [--mood <mood>] [--prompt "..."] [--approve] | --from-requests');
  const def = loadCharacter(characterId);
  const approve = has('approve');

  if (has('from-requests')) {
    const results = [];
    for (const req of listSpriteRequests(characterId)) {
      try {
        results.push(await generateOne(def, req.pose, req.mood, undefined, approve));
      } catch (err) {
        log.error(`failed ${req.pose}: ${(err as Error).message}`);
      }
    }
    emitPayload(results);
    return;
  }

  const pose = flag('pose');
  if (!pose) throw new Error('--pose is required');
  emitPayload(await generateOne(def, pose, flag('mood'), flag('prompt'), approve));
}

main().catch((err: Error) => {
  log.error(err.message);
  process.exitCode = 1;
});
