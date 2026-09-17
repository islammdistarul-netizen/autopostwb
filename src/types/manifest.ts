import { z } from 'zod';

/**
 * Core production data contracts.
 *
 * Every manifest written to storage/staged/manifest.json MUST parse against
 * ProductionPayloadSchema. The orchestrator refuses to render otherwise, which is
 * what keeps a headless `claude -p` generation step from silently drifting.
 */

/**
 * Base vocabulary every character ships with and the scriptwriter is prompted
 * with. A character may register more poses/moods in its character.json (via
 * scripts/generate-sprite.ts + approval); the orchestrator validates a manifest's
 * timeline against the *registered* set before rendering.
 */
export const BODY_POSES = ['idle', 'pointing', 'thinking', 'shocked', 'hands_on_hips'] as const;
export const FACE_MOODS = ['neutral', 'happy', 'skeptical', 'surprised'] as const;
export const VISEME_CODES = ['A', 'B', 'C', 'D', 'E', 'F', 'X'] as const;

export type BasePose = (typeof BODY_POSES)[number];
export type BaseMood = (typeof FACE_MOODS)[number];
/** snake_case identifier registered in a character.json (base set or generated). */
export type BodyPose = string;
export type FaceMood = string;
export type VisemeCode = (typeof VISEME_CODES)[number];

const IDENT = /^[a-z][a-z0-9_]{1,40}$/;
export const BodyPoseSchema = z.string().regex(IDENT, 'pose must be a snake_case identifier');
export const FaceMoodSchema = z.string().regex(IDENT, 'mood must be a snake_case identifier');
export const VisemeCodeSchema = z.enum(VISEME_CODES);

export interface TimedCaptionWord {
  word: string;
  /** In seconds. */
  start: number;
  /** In seconds. */
  end: number;
}

export const TimedCaptionWordSchema: z.ZodType<TimedCaptionWord> = z
  .object({
    word: z.string().min(1),
    start: z.number().min(0),
    end: z.number().min(0),
  })
  .refine((w) => w.end >= w.start, { message: 'caption word ends before it starts' });

export interface AvatarTimelineSegment {
  startFrame: number;
  endFrame: number;
  body: BodyPose;
  face: FaceMood;
}

export const AvatarTimelineSegmentSchema: z.ZodType<AvatarTimelineSegment> = z
  .object({
    startFrame: z.number().int().min(0),
    endFrame: z.number().int().min(0),
    body: BodyPoseSchema,
    face: FaceMoodSchema,
  })
  .refine((s) => s.endFrame > s.startFrame, { message: 'timeline segment must advance at least one frame' });

export interface CarouselSlideData {
  index: number;
  tag?: string;
  headline: string;
  content: string;
  accentPhrase?: string;
}

export const CarouselSlideDataSchema: z.ZodType<CarouselSlideData> = z.object({
  index: z.number().int().min(1),
  tag: z.string().max(40).optional(),
  headline: z.string().min(1).max(120),
  content: z.string().max(520),
  accentPhrase: z.string().max(160).optional(),
});

export const CarouselThemeSchema = z.object({
  backgroundColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  primaryTextColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  fontFamily: z.string().min(1),
});

export type CarouselTheme = z.infer<typeof CarouselThemeSchema>;

export const ProductionPayloadSchema = z.object({
  runId: z.string().min(1),
  targetDate: z.string().min(1),
  topic: z.object({
    id: z.string().min(1),
    hook: z.string().min(1),
    category: z.string().min(1),
  }),
  script: z.object({
    fullText: z.string().min(1),
    estimatedDuration: z.number().positive(),
    captions: z.array(TimedCaptionWordSchema),
  }),
  videoConfig: z.object({
    characterId: z.string().min(1),
    bRollAsset: z.string().min(1),
    musicTrack: z.string().min(1),
    timeline: z.array(AvatarTimelineSegmentSchema).min(1),
  }),
  carouselConfig: z.object({
    theme: CarouselThemeSchema,
    slides: z.array(CarouselSlideDataSchema).min(1),
  }),
  distribution: z.object({
    captionText: z.string().min(1),
    hashtags: z.array(z.string()),
    scheduledTimestamp: z.string().optional(),
    postizChannelIds: z.array(z.string()),
  }),
});

export type ProductionPayload = z.infer<typeof ProductionPayloadSchema>;

/** Rhubarb `-f json` output shape (storage/staged/mouth-cues.json). */
export const MouthCuesSchema = z.object({
  metadata: z
    .object({
      soundFile: z.string().optional(),
      duration: z.number().optional(),
    })
    .optional(),
  mouthCues: z.array(
    z.object({
      start: z.number().min(0),
      end: z.number().min(0),
      // Rhubarb emits A-H plus X; only A-F and X are in our sprite set, the rest are
      // clamped to the nearest available sprite by the avatar component.
      value: z.string().min(1),
    }),
  ),
});

export type MouthCues = z.infer<typeof MouthCuesSchema>;

export interface ManifestValidationResult {
  ok: boolean;
  payload?: ProductionPayload;
  errors: string[];
}

export function validateManifest(input: unknown): ManifestValidationResult {
  const parsed = ProductionPayloadSchema.safeParse(input);
  if (parsed.success) {
    return { ok: true, payload: parsed.data, errors: [] };
  }
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`),
  };
}

/** Throwing variant used by the orchestrator, where a bad manifest must halt the run. */
export function assertManifest(input: unknown): ProductionPayload {
  const result = validateManifest(input);
  if (!result.ok || !result.payload) {
    throw new Error(`Manifest failed ProductionPayload validation:\n  - ${result.errors.join('\n  - ')}`);
  }
  return result.payload;
}
