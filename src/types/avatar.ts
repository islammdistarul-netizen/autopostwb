import { z } from 'zod';
import { BODY_POSES, FACE_MOODS, VISEME_CODES, type BodyPose, type FaceMood, type VisemeCode } from './manifest.ts';

/** Sprite mappings, coordinates and viseme states (assets/characters/{id}/character.json). */

const PointSchema = z.object({ x: z.number(), y: z.number() });

const bodyMap = Object.fromEntries(BODY_POSES.map((p) => [p, z.string().min(1)])) as Record<
  BodyPose,
  z.ZodString
>;
const faceMap = Object.fromEntries(FACE_MOODS.map((m) => [m, z.string().min(1)])) as Record<
  FaceMood,
  z.ZodString
>;
const visemeMap = Object.fromEntries(VISEME_CODES.map((v) => [v, z.string().min(1)])) as Record<
  VisemeCode,
  z.ZodString
>;

export const CharacterDefinitionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  canvas: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  sprite: z.object({
    anchor: PointSchema,
    scale: z.number().positive(),
    bounce: z.object({
      amplitude: z.number().min(0),
      stiffness: z.number().positive(),
      damping: z.number().positive(),
    }),
  }),
  layers: z.object({
    bodies: z.object({ dir: z.string().min(1), ...bodyMap }),
    faces: z.object({
      dir: z.string().min(1),
      offset: PointSchema,
      scale: z.number().positive(),
      ...faceMap,
    }),
    mouths: z.object({
      dir: z.string().min(1),
      offset: PointSchema,
      scale: z.number().positive(),
      closed: z.string().min(1),
      ...visemeMap,
    }),
  }),
});

export type CharacterDefinition = z.infer<typeof CharacterDefinitionSchema>;

/**
 * Rhubarb can emit G and H on top of A-F/X. We never invent sprites for them
 * (see CLAUDE.md -> Zero Character Drift), so they collapse onto the closest
 * registered shape.
 */
const VISEME_FALLBACK: Record<string, VisemeCode> = {
  A: 'A',
  B: 'B',
  C: 'C',
  D: 'D',
  E: 'E',
  F: 'F',
  G: 'F',
  H: 'C',
  X: 'X',
};

export function normalizeViseme(raw: string): VisemeCode {
  return VISEME_FALLBACK[raw.trim().toUpperCase()] ?? 'X';
}

export interface ResolvedSpriteFrame {
  bodySrc: string;
  faceSrc: string;
  mouthSrc: string;
}
