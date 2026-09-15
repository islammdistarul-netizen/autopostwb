import { z } from 'zod';

/** Postiz payload interfaces and scheduling models. */

export type PostizMediaKind = 'video' | 'image';

export interface PostizUploadedMedia {
  id: string;
  path: string;
  name?: string;
}

export interface PostizPostValue {
  content: string;
  /** Ordered — carousel slide order is the array order. */
  image?: PostizUploadedMedia[];
}

export interface PostizPostRequest {
  type: 'draft' | 'schedule' | 'now';
  date: string;
  shortLink: boolean;
  tags: string[];
  posts: Array<{
    integration: { id: string };
    value: PostizPostValue[];
    settings?: Record<string, unknown>;
  }>;
}

export const PostizIntegrationSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  identifier: z.string().optional(),
  picture: z.string().optional(),
  disabled: z.boolean().optional(),
  profile: z.string().optional(),
});

export type PostizIntegration = z.infer<typeof PostizIntegrationSchema>;

export const PostizUploadResponseSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string().optional(),
});

export const PostizConfigSchema = z.object({
  host: z.string().url(),
  apiBasePath: z.string().startsWith('/'),
  apiKeyEnv: z.string().min(1),
  dispatchMode: z.enum(['rest', 'cli']),
  cliCommand: z.string().min(1),
  requestTimeoutMs: z.number().int().positive(),
  uploadTimeoutMs: z.number().int().positive(),
  channels: z.object({
    reel: z.array(z.string()),
    carousel: z.array(z.string()),
  }),
  /**
   * Per-channel provider settings merged into every post for that channel.
   * Some providers refuse posts without them, e.g.
   *   YouTube:   { "title": "...", "type": "public" }      (title falls back to the hook)
   *   TikTok:    { "privacy_level": "PUBLIC_TO_EVERYONE", "duet": false, "stitch": false, "comment": true }
   *   Instagram: { "post_type": "post" }
   */
  channelSettings: z.record(z.string(), z.record(z.string(), z.unknown())).default({}),
  channelDirectory: z.array(
    z.object({
      id: z.string(),
      label: z.string().optional(),
      platform: z.string().optional(),
    }),
  ),
  schedule: z.object({
    timezone: z.string(),
    reelSlots: z.array(z.string()),
    carouselSlots: z.array(z.string()),
    leadMinutes: z.number().int().min(0),
  }),
});

export type PostizConfig = z.infer<typeof PostizConfigSchema>;

export interface PublishResult {
  kind: 'reel' | 'carousel';
  channelIds: string[];
  scheduledFor: string;
  postIds: string[];
  dispatchedVia: 'rest' | 'cli';
}
