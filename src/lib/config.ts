import { z } from 'zod';
import { files, readJson } from './paths.ts';
import { PostizConfigSchema, type PostizConfig } from '../types/postiz.ts';

/** Typed, validated access to config/*.json. Bad config fails at load, not mid-render. */

export const AppConfigSchema = z.object({
  niche: z.object({
    id: z.string().min(1),
    title: z.string().min(1),
    language: z.string().min(2),
    keywords: z.array(z.string().min(1)).min(1),
    competitorChannels: z.array(z.string()),
    bannedTopics: z.array(z.string()),
  }),
  intelligence: z.object({
    searchProvider: z.enum(['ytsearch', 'channels', 'both']),
    videosPerKeyword: z.number().int().positive(),
    maxDurationSeconds: z.number().int().positive(),
    minViews: z.number().int().min(0),
    downloadMedia: z.boolean(),
    transcribeTopN: z.number().int().min(0),
    whisperFallback: z.boolean().default(true),
    whisperModel: z.string().min(1),
    whisperDevice: z.string().min(1),
    whisperComputeType: z.string().min(1),
    viralityWeights: z.object({
      likes: z.number(),
      comments: z.number(),
      shares: z.number(),
      saves: z.number(),
    }),
    fallbackFollowers: z.number().positive(),
    topicHistoryWindowDays: z.number().int().positive(),
    duplicateSimilarityThreshold: z.number().min(0).max(1),
  }),
  script: z.object({
    targetDurationSeconds: z.number().positive(),
    minDurationSeconds: z.number().positive(),
    maxDurationSeconds: z.number().positive(),
    wordsPerSecond: z.number().positive(),
    carouselSlides: z.object({
      min: z.number().int().positive(),
      max: z.number().int().positive(),
    }),
  }),
  voice: z.object({
    /** Default TTS engine; a preset may override it. */
    provider: z.enum(['edge', 'yandex', 'piper', 'elevenlabs']).default('edge'),
    presets: z.record(
      z.string(),
      z.object({
        provider: z.enum(['edge', 'yandex', 'piper', 'elevenlabs']).optional(),
        voice: z.string().min(1),
        /** Provider-specific knobs: edge rate/pitch/volume, yandex speed/emotion, piper length_scale, elevenlabs model/stability. */
        options: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
      }),
    ),
    defaultPreset: z.string().min(1),
    /** faster-whisper model used to align captions for engines without word timings. */
    alignModel: z.string().min(1).default('small'),
    sampleRate: z.number().int().positive(),
    channels: z.number().int().positive(),
  }),
  video: z.object({
    width: z.literal(1080),
    height: z.literal(1920),
    fps: z.literal(30),
    codec: z.literal('h264'),
    concurrency: z.number().int().positive(),
    glRenderer: z.string().min(1),
    musicVolume: z.number().min(0).max(1),
    voiceVolume: z.number().min(0).max(1),
    maxRenderSeconds: z.number().int().positive(),
    defaultCharacterId: z.string().min(1),
  }),
  carousel: z.object({
    width: z.literal(1080),
    height: z.literal(1350),
    fonts: z
      .array(
        z.object({
          name: z.string().min(1),
          file: z.string().min(1),
          weight: z.number().int().positive(),
          style: z.enum(['normal', 'italic']),
        }),
      )
      .min(1),
    theme: z.object({
      backgroundColor: z.string(),
      primaryTextColor: z.string(),
      accentColor: z.string(),
      fontFamily: z.string(),
    }),
  }),
  retention: z
    .object({
      /** How many finished runs to keep under storage/artifacts/runs. */
      keepRuns: z.number().int().min(1).default(20),
      /** Days to keep scraped competitor audio/subs in storage/raw. */
      rawDays: z.number().int().min(1).default(14),
    })
    .default({ keepRuns: 20, rawDays: 14 }),
  paths: z.object({
    storage: z.string(),
    assets: z.string(),
  }),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;
export type VoicePreset = AppConfig['voice']['presets'][string];

let appCache: AppConfig | null = null;
let postizCache: PostizConfig | null = null;

export function loadAppConfig(force = false): AppConfig {
  if (appCache && !force) return appCache;
  const parsed = AppConfigSchema.safeParse(readJson(files.appConfig));
  if (!parsed.success) {
    throw new Error(
      `config/app.config.json is invalid:\n  - ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('\n  - ')}`,
    );
  }
  appCache = parsed.data;
  return appCache;
}

export function loadPostizConfig(force = false): PostizConfig {
  if (postizCache && !force) return postizCache;
  const parsed = PostizConfigSchema.safeParse(readJson(files.postizConfig));
  if (!parsed.success) {
    throw new Error(
      `config/postiz.config.json is invalid:\n  - ${parsed.error.issues
        .map((i) => `${i.path.join('.')}: ${i.message}`)
        .join('\n  - ')}`,
    );
  }
  postizCache = parsed.data;
  return postizCache;
}

export function resolveVoicePreset(config: AppConfig, name?: string): VoicePreset {
  const key = name ?? config.voice.defaultPreset;
  const preset = config.voice.presets[key];
  if (!preset) {
    throw new Error(
      `Unknown voice preset "${key}". Available: ${Object.keys(config.voice.presets).join(', ')}`,
    );
  }
  return preset;
}
