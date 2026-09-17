import fs, { openAsBlob } from 'node:fs';
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
 * Postiz Public API v1 (https://docs.postiz.com/public-api), cross-checked
 * against a client exercised on a live instance in 08.2026 (ossclip):
 *   GET  {host}{apiBasePath}/integrations   -> connected channels {id, name, identifier, disabled}
 *   POST {host}{apiBasePath}/upload         -> multipart "file" -> {id, path}
 *   POST {host}{apiBasePath}/posts          -> {type, date, shortLink, tags: [], posts: [...]}
 * Auth: `Authorization: <POSTIZ_API_KEY>` verbatim (no Bearer).
 * Every post needs `settings.__type = <integration.identifier>`; YouTube also
 * requires `settings.type` (privacy) and Instagram `settings.post_type` — a
 * missing one rejects the WHOLE /posts call at validation, after the upload.
 * Self-hosted rate limit: 90 posts/hour.
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

/** Post ids out of whatever envelope /posts answers with — lenient by design: 2xx is the success signal. */
export function extractPostIds(json: unknown): string[] {
  const items = Array.isArray(json)
    ? json
    : json && typeof json === 'object' && Array.isArray((json as { posts?: unknown }).posts)
      ? (json as { posts: unknown[] }).posts
      : [json];
  const ids: string[] = [];
  for (const item of items) {
    if (item && typeof item === 'object') {
      const o = item as { id?: unknown; postId?: unknown };
      const id = o.postId ?? o.id;
      if (typeof id === 'string') ids.push(id);
    }
  }
  return ids;
}

export class PostizClient {
  private readonly base: string;
  private readonly apiKey: string;
  private integrationsCache: PostizIntegration[] | null = null;

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
          const waitMs = (Number.isFinite(retryAfter) ? retryAfter : 60 * attempt) * 1000;
          log.warn('Postiz rate limit (90 posts/hour), backing off', { route, attempt, waitSeconds: waitMs / 1000 });
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        if (!res.ok) {
          const hint =
            res.status === 401 || res.status === 403
              ? ' (API key rejected: Postiz -> Settings -> Public API)'
              : res.status === 413
                ? ' (upload refused as too large — usually a reverse proxy in front of Postiz, e.g. Cloudflare free caps at 100MB; call the instance directly)'
                : '';
          throw new Error(`Postiz ${method} ${route} -> ${res.status}${hint}: ${text.slice(0, 600)}`);
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

  async listIntegrations(force = false): Promise<PostizIntegration[]> {
    if (this.integrationsCache && !force) return this.integrationsCache;
    const data = await this.request<unknown>('GET', '/integrations');
    const list = Array.isArray(data) ? data : [];
    this.integrationsCache = list.map((item) => PostizIntegrationSchema.parse(item));
    return this.integrationsCache;
  }

  /** channel id -> platform identifier ("youtube", "instagram", "telegram", ...). */
  async integrationTypes(): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    for (const i of await this.listIntegrations()) {
      if (i.identifier) map.set(i.id, i.identifier);
    }
    return map;
  }

  async uploadFile(filePath: string): Promise<PostizUploadedMedia> {
    if (!fs.existsSync(filePath)) throw new Error(`Upload source missing: ${filePath}`);
    const name = path.basename(filePath);
    const mime = MIME[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
    const form = new FormData();
    // openAsBlob streams the file into multipart without holding it in memory.
    form.append('file', await openAsBlob(filePath, { type: mime }), name);

    log.info('uploading to Postiz', { file: name, mb: Number((fs.statSync(filePath).size / 1024 / 1024).toFixed(1)) });
    const data = await this.request<unknown>('POST', '/upload', form, this.config.uploadTimeoutMs);
    const parsed = PostizUploadResponseSchema.parse(data);
    return { id: parsed.id, path: parsed.path, name: parsed.name ?? name };
  }

  async createPost(request: PostizPostRequest): Promise<string[]> {
    for (const p of request.posts) {
      if (!p.settings || typeof p.settings.__type !== 'string') {
        throw new Error(`post for integration ${p.integration.id} lacks settings.__type (platform identifier) — Postiz rejects the whole request without it`);
      }
    }
    const data = await this.request<unknown>('POST', '/posts', JSON.stringify(request));
    return extractPostIds(data);
  }

  /**
   * Optional CLI dispatch. No official `postiz` CLI package exists on npm as of
   * 09.2026 (checked @gitroomhq/postiz-agent, postiz-agent, @postiz/cli);
   * kept as an adapter for a locally installed tool with that interface.
   */
  async createPostViaCli(caption: string, mediaPaths: string[], channelIds: string[], date: string): Promise<string[]> {
    if (!(await which(this.config.cliCommand))) {
      throw new Error(`${this.config.cliCommand} CLI not found; set dispatchMode to "rest".`);
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
