import fs from 'node:fs';
import path from 'node:path';
import { log } from '../../lib/log.ts';
import { run, which } from '../../lib/shell.ts';
import {
  PostizIntegrationSchema,
  PostizUploadResponseSchema,
  type PostizConfig,
  type PostizIntegration,
  type PostizPostRequest,
  type PostizUploadedMedia,
} from '../../types/postiz.ts';

/**
 * Unified API client communicating with the self-hosted Postiz instance.
 *
 * Postiz Public API v1 (the only stable surface):
 *   GET  {host}{apiBasePath}/integrations   -> connected channels
 *   POST {host}{apiBasePath}/upload         -> multipart file upload, returns {id, path}
 *   POST {host}{apiBasePath}/posts          -> create/schedule posts
 * Auth: `Authorization: <POSTIZ_API_KEY>` (raw key, no Bearer prefix).
 *
 * The spec's `http://localhost:5000/api/posts` is the *internal* backend route;
 * on a docker-compose install the public API sits under /api/public/v1, which
 * is what config/postiz.config.json points at.
 *
 * Nothing here talks to Instagram/TikTok/etc. directly — Postiz owns OAuth,
 * rate limits and scheduling.
 */

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export class PostizClient {
  private readonly base: string;
  private readonly apiKey: string;

  constructor(private readonly config: PostizConfig) {
    this.base = config.host.replace(/\/+$/, '') + config.apiBasePath.replace(/\/+$/, '');
    const key = process.env[config.apiKeyEnv];
    if (!key) {
      throw new Error(
        `${config.apiKeyEnv} is not set. Create a key in Postiz -> Settings -> Public API and export it (see .env.example).`,
      );
    }
    this.apiKey = key;
  }

  /**
   * The public API is rate-limited (30 requests/hour on a default install), and
   * one full run spends ~10 (uploads + posts). 429s are retried with backoff
   * honouring Retry-After; anything else fails fast so the run log shows it.
   */
  private async request<T>(method: 'GET' | 'POST', route: string, body?: BodyInit, timeoutMs?: number): Promise<T> {
    const url = `${this.base}${route}`;
    const maxAttempts = 4;
    for (let attempt = 1; ; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.config.requestTimeoutMs);
      try {
        const headers: Record<string, string> = { Authorization: this.apiKey, Accept: 'application/json' };
        if (body && !(body instanceof FormData)) headers['Content-Type'] = 'application/json';
        const res = await fetch(url, { method, headers, body, signal: controller.signal });
        const text = await res.text();
        if (res.status === 429 && attempt < maxAttempts) {
          const retryAfter = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
          const waitMs = (Number.isFinite(retryAfter) ? retryAfter : 30 * attempt) * 1000;
          log.warn('Postiz rate limit hit, backing off', { route, attempt, waitSeconds: waitMs / 1000 });
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        if (!res.ok) {
          throw new Error(`Postiz ${method} ${route} -> ${res.status}: ${text.slice(0, 600)}`);
        }
        return (text ? JSON.parse(text) : {}) as T;
      } catch (err) {
        if ((err as Error).name === 'AbortError') {
          throw new Error(`Postiz ${method} ${route} timed out after ${timeoutMs ?? this.config.requestTimeoutMs}ms`);
        }
        throw err;
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async listIntegrations(): Promise<PostizIntegration[]> {
    const data = await this.request<unknown>('GET', '/integrations');
    const list = Array.isArray(data) ? data : [];
    return list.map((item) => PostizIntegrationSchema.parse(item));
  }

  async uploadFile(filePath: string): Promise<PostizUploadedMedia> {
    if (!fs.existsSync(filePath)) throw new Error(`Upload source missing: ${filePath}`);
    const name = path.basename(filePath);
    const mime = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(filePath)], { type: mime }), name);

    log.info('uploading to Postiz', { file: name, mb: Number((fs.statSync(filePath).size / 1024 / 1024).toFixed(1)) });
    const data = await this.request<unknown>('POST', '/upload', form, this.config.uploadTimeoutMs);
    const parsed = PostizUploadResponseSchema.parse(data);
    return { id: parsed.id, path: parsed.path, name: parsed.name ?? name };
  }

  async createPost(request: PostizPostRequest): Promise<string[]> {
    const data = await this.request<unknown>('POST', '/posts', JSON.stringify(request));
    // Postiz returns an array of {postId, integration} (one per channel) or a single object.
    const items = Array.isArray(data) ? data : [data];
    return items
      .map((item) => {
        const o = item as { postId?: string; id?: string };
        return o.postId ?? o.id ?? '';
      })
      .filter(Boolean);
  }

  /**
   * Optional CLI dispatch (`postiz posts:create ...`). Kept as an adapter for
   * environments where the agent package is preferred; REST is the default
   * because its request shape is documented and validated above.
   */
  async createPostViaCli(caption: string, mediaPaths: string[], channelIds: string[], date: string): Promise<string[]> {
    if (!(await which(this.config.cliCommand))) {
      throw new Error(`${this.config.cliCommand} CLI not found; set dispatchMode to "rest" or install @gitroomhq/postiz-agent.`);
    }
    const result = await run(
      this.config.cliCommand,
      ['posts:create', '-c', caption, '-m', mediaPaths.join(','), '-i', channelIds.join(','), '-d', date],
      { env: { POSTIZ_API_KEY: this.apiKey, POSTIZ_URL: this.config.host }, timeoutMs: this.config.uploadTimeoutMs },
    );
    const ids = [...result.stdout.matchAll(/[0-9a-f]{8}-[0-9a-f-]{27}|c[a-z0-9]{24}/gi)].map((m) => m[0]);
    return ids.length ? ids : ['cli-dispatched'];
  }
}
