import { z } from 'zod';
import { MouthCuesSchema, ProductionPayloadSchema } from '../../types/manifest.ts';
import { CharacterDefinitionSchema } from '../../types/avatar.ts';

/**
 * Props for ReelComposition.
 *
 * The CLI is invoked with `--props=storage/staged/manifest.json`, i.e. a bare
 * ProductionPayload. calculateMetadata() then enriches it in the browser with
 * everything else the timeline needs (mouth cues, sprite index, media durations)
 * fetched from the public dir, so the manifest never has to embed binary-derived
 * data and stays hand-editable.
 */

export const VIDEO_WIDTH = 1080;
export const VIDEO_HEIGHT = 1920;
export const VIDEO_FPS = 30;

/** Relative to the Remotion public dir (storage/staged/public). */
export const PUBLIC_PATHS = {
  voice: 'voice.wav',
  mouthCues: 'mouth-cues.json',
  characters: 'assets/characters',
  bRoll: 'assets/b-roll',
  music: 'assets/music',
  fonts: 'assets/fonts',
} as const;

export const RuntimeSchema = z.object({
  mouthCues: MouthCuesSchema,
  character: CharacterDefinitionSchema,
  voiceDurationSeconds: z.number().positive(),
  bRollDurationSeconds: z.number().positive(),
  musicVolume: z.number().min(0).max(1),
  voiceVolume: z.number().min(0).max(1),
});

export const ReelPropsSchema = ProductionPayloadSchema.extend({
  runtime: RuntimeSchema.optional(),
});

export type ReelProps = z.infer<typeof ReelPropsSchema>;
export type ReelRuntime = z.infer<typeof RuntimeSchema>;
export type ResolvedReelProps = ReelProps & { runtime: ReelRuntime };
