import path from 'node:path';
import { log } from '../../lib/log.ts';
import { files, paths, readJsonIfExists, writeJson } from '../../lib/paths.ts';
import type { AppConfig } from '../../lib/config.ts';
import { downloadAudio, fetchAutoSubs, scrapeCompetitors, type CompetitorVideo } from './scraper.ts';
import { autoSubsToTranscript, transcribe, type Transcript } from './transcriber.ts';

/**
 * Virality scoring and structured hook classification.
 *
 * Output (storage/raw/topics.json) is the contract between intelligence and
 * scripting: a ranked list of topic candidates, each carrying the proven hook
 * pattern that made the competitor video work, deduplicated against everything
 * we already published in the last N days.
 */

export type HookType =
  | 'question'
  | 'warning'
  | 'myth_bust'
  | 'numbered_list'
  | 'personal_story'
  | 'contrarian'
  | 'how_to'
  | 'curiosity_gap'
  | 'unknown';

export interface TopicCandidate {
  id: string;
  /** Verbatim opening line (or title when no transcript) — the proven hook. */
  hook: string;
  hookType: HookType;
  /** Human-readable working title for the script step. */
  title: string;
  category: string;
  score: number;
  keywords: string[];
  source: {
    videoId: string;
    url: string;
    channel: string;
    views: number;
    likes: number;
    comments: number;
    durationSeconds: number;
    query: string;
  };
  transcriptExcerpt: string | null;
  hasTranscript: boolean;
}

export interface TopicsFile {
  generatedAt: string;
  niche: string;
  windowDays: number;
  candidates: TopicCandidate[];
}

export interface TopicHistoryEntry {
  topicId: string;
  hook: string;
  keywords: string[];
  usedAt: string;
  runId: string;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Score = (Views / Followers) * ((Likes + 2.0*Comments + 3.5*Shares + 4.0*Saves) / Views) */
export function viralityScore(video: CompetitorVideo, weights: AppConfig['intelligence']['viralityWeights']): number {
  if (video.views <= 0 || video.channelFollowers <= 0) return 0;
  const reach = video.views / video.channelFollowers;
  const engagement =
    (weights.likes * video.likes +
      weights.comments * video.comments +
      weights.shares * video.shares +
      weights.saves * video.saves) /
    video.views;
  return Number((reach * engagement).toFixed(6));
}

// ---------------------------------------------------------------------------
// Text utilities (Russian-aware, dependency-free)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  (
    'и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о ' +
    'из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ' +
    'ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто ' +
    'этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно ' +
    'при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем ' +
    'хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между это вот это shorts short ' +
    'видео ролик'
  ).split(/\s+/),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-zа-яё0-9\s-]/gi, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 2 && !STOPWORDS.has(t))
    // crude stemming keeps «витамин/витамины/витамина» together
    .map((t) => (t.length > 6 ? t.slice(0, 6) : t));
}

export function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const sa = new Set(a);
  const sb = new Set(b);
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter += 1;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export function topKeywords(text: string, limit = 8): string[] {
  const counts = new Map<string, number>();
  for (const token of tokenize(text)) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
    .slice(0, limit)
    .map(([token]) => token);
}

function firstSentence(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  const match = cleaned.match(/^(.+?[.!?…])(\s|$)/);
  const sentence = match?.[1] ?? cleaned;
  return sentence.length > 160 ? sentence.slice(0, 157).trimEnd() + '…' : sentence;
}

// ---------------------------------------------------------------------------
// Hook classification
// ---------------------------------------------------------------------------

// NB: JS `\b` is ASCII-only, so Cyrillic word starts are guarded with a lookbehind instead.
const HOOK_RULES: Array<{ type: HookType; pattern: RegExp }> = [
  { type: 'myth_bust', pattern: /(?<![а-яёa-z0-9])(миф|неправда|на самом деле|враньё|вранье|обман|не работает|развод)/i },
  { type: 'warning', pattern: /(?<![а-яёa-z0-9])(никогда|нельзя|опасно|ошибк|перестань|прекрати|стоп|осторожно|вред)/i },
  { type: 'numbered_list', pattern: /(?<![а-яёa-z0-9])(\d+|три|пять|семь|десять)\s+(причин|способ|признак|продукт|ошиб|правил|шаг|вещ)/i },
  { type: 'how_to', pattern: /(?<![а-яёa-z0-9])(как\s+(быстро|правильно|легко|поднять|убрать|понять|выбрать|начать)|инструкция|пошагово)/i },
  { type: 'contrarian', pattern: /(?<![а-яёa-z0-9])(все\s+(думают|делают|ошибаются)|вопреки|наоборот|а\s+вы\s+знали|вы\s+удивитесь)/i },
  { type: 'personal_story', pattern: /(?<![а-яёa-z0-9])(я\s+(пробовал|пробовала|сделал|сделала|потерял|потеряла|набрал|набрала)|моя\s+история|у\s+меня\s+было)/i },
  { type: 'question', pattern: /\?\s*$|^(почему|зачем|что\s+будет|а\s+вы|знаете\s+ли|как\s+думаете)/i },
  { type: 'curiosity_gap', pattern: /(?<![а-яёa-z0-9])(секрет|никто\s+не\s+(говорит|скажет)|скрывают|не\s+расскажут|мало\s+кто\s+знает|шок)/i },
];

export function classifyHook(hook: string): HookType {
  for (const rule of HOOK_RULES) {
    if (rule.pattern.test(hook)) return rule.type;
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Topic extraction
// ---------------------------------------------------------------------------

function isBanned(text: string, banned: string[]): boolean {
  const lower = text.toLowerCase();
  return banned.some((b) => b.trim() && lower.includes(b.toLowerCase()));
}

export function loadTopicHistory(windowDays: number): TopicHistoryEntry[] {
  const history = readJsonIfExists<TopicHistoryEntry[]>(files.topicHistory) ?? [];
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  return history.filter((h) => Date.parse(h.usedAt) >= cutoff);
}

export function recordTopicUsage(entry: TopicHistoryEntry): void {
  const history = readJsonIfExists<TopicHistoryEntry[]>(files.topicHistory) ?? [];
  history.push(entry);
  writeJson(files.topicHistory, history);
}

function buildCandidate(
  video: CompetitorVideo,
  transcript: Transcript | null,
  score: number,
  nicheId: string,
): TopicCandidate {
  const hookSource = transcript?.text?.trim() ? transcript.text : video.title;
  const hook = firstSentence(hookSource) || video.title;
  const hookType = classifyHook(hook + ' ' + video.title);
  const keywords = topKeywords(`${video.title} ${transcript?.text ?? ''} ${video.tags.join(' ')}`);

  return {
    id: `${nicheId}-${video.id}`,
    hook,
    hookType,
    title: video.title,
    category: hookType,
    score,
    keywords,
    source: {
      videoId: video.id,
      url: video.url,
      channel: video.channel,
      views: video.views,
      likes: video.likes,
      comments: video.comments,
      durationSeconds: video.durationSeconds,
      query: video.sourceQuery,
    },
    transcriptExcerpt: transcript ? transcript.text.slice(0, 600) : null,
    hasTranscript: Boolean(transcript),
  };
}

/** Drops candidates too close to each other or to recently published topics. */
export function dedupeCandidates(
  candidates: TopicCandidate[],
  history: TopicHistoryEntry[],
  threshold: number,
): TopicCandidate[] {
  const kept: TopicCandidate[] = [];
  const historyTokens = history.map((h) => h.keywords.length ? h.keywords : tokenize(h.hook));

  for (const candidate of candidates) {
    const tokens = candidate.keywords.length ? candidate.keywords : tokenize(candidate.hook);
    const clashesHistory = historyTokens.some((h) => jaccard(tokens, h) >= threshold);
    if (clashesHistory) {
      log.debug('topic skipped: recently used', { id: candidate.id });
      continue;
    }
    const clashesKept = kept.some((k) => jaccard(tokens, k.keywords) >= threshold);
    if (clashesKept) {
      log.debug('topic skipped: duplicate of higher-ranked candidate', { id: candidate.id });
      continue;
    }
    kept.push(candidate);
  }
  return kept;
}

export interface IntelligenceOptions {
  /** Skip yt-dlp and reuse storage/raw/competitors.json. */
  reuseScrape?: boolean;
  /** Override transcribeTopN (0 disables transcription entirely). */
  transcribeTopN?: number;
}

export async function runIntelligence(config: AppConfig, options: IntelligenceOptions = {}): Promise<TopicsFile> {
  log.step('Intelligence: competitor parsing & hook extraction');

  const scrape = options.reuseScrape
    ? readJsonIfExists<{ videos: CompetitorVideo[] }>(path.join(paths.raw, 'competitors.json'))
    : await scrapeCompetitors(config);
  if (!scrape || scrape.videos.length === 0) {
    throw new Error('No competitor videos available. Check niche.keywords / minViews, or drop --reuse-scrape.');
  }

  const scored = scrape.videos
    .filter((v) => !isBanned(`${v.title} ${v.description}`, config.niche.bannedTopics))
    .map((video) => ({ video, score: viralityScore(video, config.intelligence.viralityWeights) }))
    .sort((a, b) => b.score - a.score);

  const topN = options.transcribeTopN ?? config.intelligence.transcribeTopN;
  const transcripts = new Map<string, Transcript>();
  if (topN > 0) {
    log.step(`Transcribing top ${Math.min(topN, scored.length)} candidates (auto-subs first, whisper fallback)`);
    for (const { video } of scored.slice(0, topN)) {
      try {
        // 1. YouTube's own timed captions: free and instant.
        const subs = await fetchAutoSubs(video, config.niche.language);
        const fromSubs = subs ? autoSubsToTranscript(subs, config.niche.language) : null;
        if (fromSubs) {
          transcripts.set(video.id, fromSubs);
          continue;
        }
        // 2. No captions -> download audio and run faster-whisper.
        if (!config.intelligence.whisperFallback) {
          log.info('no auto-subs and whisper fallback disabled; using title', { id: video.id });
          continue;
        }
        const audio = await downloadAudio(video);
        transcripts.set(video.id, await transcribe(audio, config));
      } catch (err) {
        log.warn('transcription failed, using title as hook', { id: video.id, error: (err as Error).message });
      }
    }
  }

  const history = loadTopicHistory(config.intelligence.topicHistoryWindowDays);
  const candidates = scored.map(({ video, score }) =>
    buildCandidate(video, transcripts.get(video.id) ?? null, score, config.niche.id),
  );
  const deduped = dedupeCandidates(candidates, history, config.intelligence.duplicateSimilarityThreshold);

  const topics: TopicsFile = {
    generatedAt: new Date().toISOString(),
    niche: config.niche.id,
    windowDays: config.intelligence.topicHistoryWindowDays,
    candidates: deduped,
  };
  writeJson(files.topics, topics);
  log.info('topics written', { file: files.topics, candidates: deduped.length, droppedAsDuplicate: candidates.length - deduped.length });
  return topics;
}
