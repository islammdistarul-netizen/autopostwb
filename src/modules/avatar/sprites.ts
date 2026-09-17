import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { log } from '../../lib/log.ts';
import { ensureDir, paths, readJson, readJsonIfExists, writeJson } from '../../lib/paths.ts';
import { run } from '../../lib/shell.ts';
import { CharacterDefinitionSchema, registeredPoses, type CharacterDefinition } from '../../types/avatar.ts';

/**
 * Sprite intake pipeline: raw art (drawn or generated) -> clean, normalized,
 * registered sprite. Runs strictly outside the render loop:
 *
 *   prepare  : background removal (rembg) -> trim -> fit to spriteCanvas,
 *              bottom-centred -> candidate PNG + preview with alignment guides
 *   register : copy the approved candidate into the character dir and add it
 *              to character.json (a new pose or a pose×mood frame)
 *   request  : the scriptwriter logs poses it wanted but the character lacks,
 *              so they can be generated and approved in a later, human-gated step
 */

export const CANDIDATES_DIR = path.join(paths.cache, 'sprite-candidates');
export const REQUESTS_FILE = path.join(paths.cache, 'sprite-requests.json');

export interface SpriteRequest {
  characterId: string;
  pose: string;
  mood?: string;
  reason: string;
  firstSeen: string;
  count: number;
}

export function characterDir(characterId: string): string {
  return path.join(paths.characters, characterId);
}

export function loadCharacter(characterId: string): CharacterDefinition {
  const file = path.join(characterDir(characterId), 'character.json');
  if (!fs.existsSync(file)) throw new Error(`character.json not found for "${characterId}" (${file})`);
  return CharacterDefinitionSchema.parse(readJson(file));
}

export function saveCharacter(def: CharacterDefinition): void {
  // Assets are provisioned, not pipeline output, so this is the one deliberate write outside storage/.
  fs.writeFileSync(path.join(characterDir(def.id), 'character.json'), JSON.stringify(def, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export function recordSpriteRequest(req: Omit<SpriteRequest, 'firstSeen' | 'count'>): void {
  const all = readJsonIfExists<SpriteRequest[]>(REQUESTS_FILE) ?? [];
  const existing = all.find((r) => r.characterId === req.characterId && r.pose === req.pose && (r.mood ?? '') === (req.mood ?? ''));
  if (existing) existing.count += 1;
  else all.push({ ...req, firstSeen: new Date().toISOString(), count: 1 });
  writeJson(REQUESTS_FILE, all);
}

export function listSpriteRequests(characterId?: string): SpriteRequest[] {
  const all = readJsonIfExists<SpriteRequest[]>(REQUESTS_FILE) ?? [];
  return characterId ? all.filter((r) => r.characterId === characterId) : all;
}

function dropSpriteRequest(characterId: string, pose: string, mood?: string): void {
  const all = readJsonIfExists<SpriteRequest[]>(REQUESTS_FILE) ?? [];
  writeJson(
    REQUESTS_FILE,
    all.filter((r) => !(r.characterId === characterId && r.pose === pose && (r.mood ?? '') === (mood ?? ''))),
  );
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

export interface PrepareOptions {
  characterId: string;
  input: string;
  pose: string;
  mood?: string;
  /** auto (default): remove when the image has no transparency. */
  removeBackground?: boolean | 'auto';
  /** rembg model; isnet-anime is the best fit for flat/cartoon art. */
  rembgModel?: string;
}

export interface PreparedSprite {
  candidatePath: string;
  previewPath: string;
  width: number;
  height: number;
}

async function hasTransparency(file: string): Promise<boolean> {
  const meta = await sharp(file).metadata();
  if (!meta.hasAlpha) return false;
  const stats = await sharp(file).stats();
  const alpha = stats.channels[3];
  return Boolean(alpha && alpha.min < 250);
}

async function removeBackground(input: string, output: string, model: string): Promise<void> {
  const probe = await run('python3', ['-c', 'import rembg'], { allowFailure: true });
  if (probe.code !== 0) throw new Error('rembg missing: pip3 install "rembg[cpu]"');
  await run('python3', ['-m', 'rembg', 'i', '-m', model, '-a', input, output], { timeoutMs: 10 * 60 * 1000 });
}

export function candidateName(pose: string, mood?: string): string {
  return mood && mood !== 'neutral' ? `${pose}__${mood}.png` : `${pose}.png`;
}

export async function prepareSprite(options: PrepareOptions): Promise<PreparedSprite> {
  const def = loadCharacter(options.characterId);
  const { width, height } = def.spriteCanvas;
  const outDir = ensureDir(path.join(CANDIDATES_DIR, def.id));
  const candidatePath = path.join(outDir, candidateName(options.pose, options.mood));
  const previewPath = candidatePath.replace(/\.png$/, '.preview.png');

  let source = options.input;
  const mode = options.removeBackground ?? 'auto';
  const needsRembg = mode === true || (mode === 'auto' && !(await hasTransparency(source)));
  if (needsRembg) {
    const cut = path.join(outDir, `${path.basename(candidatePath, '.png')}.cutout.png`);
    log.info('removing background', { model: options.rembgModel ?? 'isnet-anime' });
    await removeBackground(source, cut, options.rembgModel ?? 'isnet-anime');
    source = cut;
  }

  // Trim transparent margins, fit inside the sprite canvas, sit on the bottom edge, centred.
  const trimmed = await sharp(source).ensureAlpha().trim().toBuffer();
  const fitted = await sharp(trimmed).resize({ width, height, fit: 'inside', withoutEnlargement: false }).toBuffer();
  const fittedMeta = await sharp(fitted).metadata();
  const left = Math.round((width - (fittedMeta.width ?? width)) / 2);
  const top = height - (fittedMeta.height ?? height);
  await sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: fitted, left, top }])
    .png()
    .toFile(candidatePath);

  // Preview: grey ground + crosshairs where the mouth (and face) overlays will land.
  const cx = width / 2;
  const cy = height / 2;
  const guide = (o: { x: number; y: number }, color: string) =>
    `<line x1="${cx + o.x - 40}" y1="${cy + o.y}" x2="${cx + o.x + 40}" y2="${cy + o.y}" stroke="${color}" stroke-width="3"/>` +
    `<line x1="${cx + o.x}" y1="${cy + o.y - 40}" x2="${cx + o.x}" y2="${cy + o.y + 40}" stroke="${color}" stroke-width="3"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    ${guide(def.layers.mouths.offset, '#ff3b3b')}
    ${def.layers.faces ? guide(def.layers.faces.offset, '#3b7bff') : ''}
    <text x="16" y="${height - 16}" font-family="sans-serif" font-size="22" fill="#fff">${options.pose}${options.mood ? ' / ' + options.mood : ''} — red: mouth, blue: face</text>
  </svg>`;
  await sharp({ create: { width, height, channels: 4, background: { r: 80, g: 84, b: 92, alpha: 1 } } })
    .composite([{ input: candidatePath }, { input: Buffer.from(svg) }])
    .png()
    .toFile(previewPath);

  log.info('sprite candidate ready', { candidate: candidatePath, preview: previewPath });
  return { candidatePath, previewPath, width, height };
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export interface RegisterOptions {
  characterId: string;
  pose: string;
  mood?: string;
  candidatePath?: string;
}

export function registerSprite(options: RegisterOptions): { installedPath: string; def: CharacterDefinition } {
  const def = loadCharacter(options.characterId);
  const candidate = options.candidatePath ?? path.join(CANDIDATES_DIR, def.id, candidateName(options.pose, options.mood));
  if (!fs.existsSync(candidate)) throw new Error(`Candidate not found: ${candidate}. Run prepare first.`);
  if (!/^[a-z][a-z0-9_]{1,40}$/.test(options.pose)) throw new Error(`Pose must be snake_case: ${options.pose}`);

  const mood = options.mood && options.mood !== 'neutral' ? options.mood : undefined;
  let relTarget: string;

  if (!mood) {
    relTarget = `${def.layers.bodies.dir}/body_${options.pose}.png`;
    (def.layers.bodies as Record<string, string>)[options.pose] = `body_${options.pose}.png`;
  } else {
    if (def.mode !== 'composite') {
      throw new Error('Pose×mood frames are only used in composite mode; in layered mode add a face overlay instead.');
    }
    if (!registeredPoses(def).includes(options.pose)) {
      throw new Error(`Register the neutral frame for "${options.pose}" first (without --mood).`);
    }
    if (!def.layers.frames) def.layers.frames = { dir: 'frames', byPose: {} };
    const byMood = def.layers.frames.byPose[options.pose] ?? {};
    byMood[mood] = `${options.pose}_${mood}.png`;
    def.layers.frames.byPose[options.pose] = byMood;
    relTarget = `${def.layers.frames.dir}/${options.pose}_${mood}.png`;
  }

  const installedPath = path.join(characterDir(def.id), relTarget);
  ensureDir(path.dirname(installedPath));
  fs.copyFileSync(candidate, installedPath);
  saveCharacter(CharacterDefinitionSchema.parse(def));
  dropSpriteRequest(def.id, options.pose, mood);
  log.info('sprite registered', { pose: options.pose, mood: mood ?? 'neutral', file: relTarget });
  return { installedPath, def };
}
