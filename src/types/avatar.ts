import { z } from 'zod';
import { VISEME_CODES, type VisemeCode } from './manifest.ts';

/**
 * Sprite mappings, coordinates and viseme states (assets/characters/{id}/character.json).
 *
 * Two assembly modes:
 *   layered   — body (no face) + face overlay + mouth overlay. 5 + 4 + 8 files.
 *               Head must sit at the same spot in every body sprite.
 *   composite — one full-character frame per pose×mood (face baked in) + mouth
 *               overlay. Generated art holds together better this way because
 *               every frame is produced from the same character reference.
 *               `frames[pose][mood]` is optional; a missing mood falls back to
 *               `bodies[pose]` (the neutral frame for that pose).
 * Poses and moods are whatever the character registers — the base set in
 * manifest.ts is the vocabulary the scriptwriter is prompted with; new ones
 * are added through scripts/generate-sprite.ts + approval, never at render time.
 */

const PointSchema = z.object({ x: z.number(), y: z.number() });
const FileName = z.string().min(1);

const visemeMap = Object.fromEntries(VISEME_CODES.map((v) => [v, FileName])) as Record<VisemeCode, z.ZodString>;

export const CharacterDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  mode: z.enum(['layered', 'composite']).default('layered'),
  canvas: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  /** Native size of body/frame sprites; prepare-sprites fits new art to it. */
  spriteCanvas: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).default({ width: 720, height: 960 }),
  sprite: z.object({
    anchor: PointSchema,
    scale: z.number().positive(),
    bounce: z.object({
      amplitude: z.number().min(0),
      stiffness: z.number().positive(),
      damping: z.number().positive(),
    }),
  }),
  motion: z
    .object({
      blinkEverySeconds: z.number().positive().default(4),
      blinkFrames: z.number().int().positive().default(3),
      breathe: z.boolean().default(true),
    })
    .default({ blinkEverySeconds: 4, blinkFrames: 3, breathe: true }),
  /** How scripts/generate-sprite.ts keeps new art on-model. Optional; without it generation is disabled. */
  generation: z
    .object({
      /** Reference sheet (relative to the character dir) sent with every generation request. */
      reference: z.string().min(1),
      /** Style lock, prepended to every prompt: medium, line weight, palette, camera, lighting. */
      stylePrompt: z.string().min(1),
      /** Per-pose prompt fragments; unknown poses fall back to a generic description of the identifier. */
      posePrompts: z.record(z.string(), z.string()).default({}),
      moodPrompts: z.record(z.string(), z.string()).default({}),
    })
    .optional(),
  layers: z.object({
    /** pose -> file. Every registered pose lives here (composite: neutral-face frame). */
    bodies: z.object({ dir: FileName }).catchall(FileName),
    /** composite only: byPose[pose][mood] -> file. */
    frames: z
      .object({ dir: FileName, byPose: z.record(z.string(), z.record(z.string(), FileName)).default({}) })
      .optional(),
    /** layered: mood -> file. */
    faces: z
      .object({ dir: FileName, offset: PointSchema, scale: z.number().positive() })
      .catchall(FileName)
      .optional(),
    mouths: z.object({
      dir: FileName,
      offset: PointSchema,
      scale: z.number().positive(),
      closed: FileName,
      ...visemeMap,
    }),
    /** Optional eyes-closed overlay for deterministic blinking. */
    blink: z
      .object({ dir: FileName, file: FileName, offset: PointSchema, scale: z.number().positive() })
      .optional(),
  }),
});

export type CharacterDefinition = z.infer<typeof CharacterDefinitionSchema>;

const RESERVED = new Set(['dir', 'offset', 'scale', 'file']);

function entries(obj: Record<string, unknown>): Array<[string, string]> {
  return Object.entries(obj).filter(([k, v]) => !RESERVED.has(k) && typeof v === 'string') as Array<[string, string]>;
}

export function registeredPoses(def: CharacterDefinition): string[] {
  return entries(def.layers.bodies).map(([k]) => k);
}

export function registeredMoods(def: CharacterDefinition): string[] {
  if (def.mode === 'layered') return def.layers.faces ? entries(def.layers.faces).map(([k]) => k) : [];
  const moods = new Set<string>(['neutral']);
  for (const byMood of Object.values(def.layers.frames?.byPose ?? {})) {
    for (const m of Object.keys(byMood)) moods.add(m);
  }
  return [...moods];
}

/** Every sprite file the definition references, relative to the character dir. */
export function listCharacterSprites(def: CharacterDefinition): string[] {
  const out: string[] = [];
  for (const [, f] of entries(def.layers.bodies)) out.push(`${def.layers.bodies.dir}/${f}`);
  if (def.layers.frames) {
    for (const byMood of Object.values(def.layers.frames.byPose)) {
      for (const f of Object.values(byMood)) out.push(`${def.layers.frames.dir}/${f}`);
    }
  }
  if (def.layers.faces) for (const [, f] of entries(def.layers.faces)) out.push(`${def.layers.faces.dir}/${f}`);
  for (const [, f] of entries(def.layers.mouths)) out.push(`${def.layers.mouths.dir}/${f}`);
  if (def.layers.blink) out.push(`${def.layers.blink.dir}/${def.layers.blink.file}`);
  return out;
}

/** Validation problems for a definition beyond the schema (mode-specific requirements). */
export function characterProblems(def: CharacterDefinition): string[] {
  const problems: string[] = [];
  if (registeredPoses(def).length === 0) problems.push('no poses registered in layers.bodies');
  if (def.mode === 'layered' && (!def.layers.faces || registeredMoods(def).length === 0)) {
    problems.push('layered mode requires layers.faces with at least one mood');
  }
  if (def.mode === 'composite' && def.layers.frames) {
    const poses = new Set(registeredPoses(def));
    for (const k of Object.keys(def.layers.frames.byPose)) {
      if (!poses.has(k)) problems.push(`frames.byPose.${k} has no matching bodies.${k} (neutral fallback)`);
    }
  }
  return problems;
}

/**
 * Rhubarb can emit G and H on top of A-F/X even though we ask it not to. We
 * never invent sprites for them (CLAUDE.md -> Zero Character Drift), so they
 * collapse onto the closest registered shape.
 */
const VISEME_FALLBACK: Record<string, VisemeCode> = { A: 'A', B: 'B', C: 'C', D: 'D', E: 'E', F: 'F', G: 'F', H: 'C', X: 'X' };

export function normalizeViseme(raw: string): VisemeCode {
  return VISEME_FALLBACK[raw.trim().toUpperCase()] ?? 'X';
}

export interface ResolvedSprites {
  /** Relative to the character dir. */
  body: string;
  face: string | null;
  mouth: string;
  blink: string | null;
}

/**
 * Pure lookup: which files to draw for this pose/mood/viseme. Unknown poses or
 * moods degrade to the first registered ones rather than throwing mid-render.
 */
export function resolveSprites(def: CharacterDefinition, pose: string, mood: string, viseme: VisemeCode, blinking: boolean): ResolvedSprites {
  const bodies = def.layers.bodies as Record<string, string>;
  const poseKey = bodies[pose] ? pose : registeredPoses(def)[0]!;

  let body = `${def.layers.bodies.dir}/${bodies[poseKey]}`;
  let face: string | null = null;

  if (def.mode === 'composite') {
    const frame = def.layers.frames?.byPose[poseKey]?.[mood];
    if (frame && def.layers.frames) body = `${def.layers.frames.dir}/${frame}`;
  } else if (def.layers.faces) {
    const faces = def.layers.faces as unknown as Record<string, string>;
    const moodKey = faces[mood] ? mood : registeredMoods(def)[0]!;
    face = `${def.layers.faces.dir}/${faces[moodKey]}`;
  }

  const mouths = def.layers.mouths;
  const mouth = `${mouths.dir}/${viseme === 'X' ? mouths.closed : mouths[viseme]}`;
  const blink = blinking && def.layers.blink ? `${def.layers.blink.dir}/${def.layers.blink.file}` : null;
  return { body, face, mouth, blink };
}

/**
 * Deterministic blink schedule: two interleaved cycles of different lengths so
 * blinks look irregular without any randomness.
 */
export function isBlinking(frame: number, fps: number, motion: CharacterDefinition['motion']): boolean {
  const period = Math.max(fps, Math.round(motion.blinkEverySeconds * fps));
  const period2 = Math.round(period * 1.7) + 7;
  const a = frame % period < motion.blinkFrames;
  const b = (frame + Math.round(period * 0.37)) % period2 < motion.blinkFrames;
  return a || b;
}
