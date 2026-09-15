import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { log } from '../../lib/log.ts';
import { paths } from '../../lib/paths.ts';
import { run, which } from '../../lib/shell.ts';
import type { AppConfig } from '../../lib/config.ts';
import {
  BODY_POSES,
  BodyPoseSchema,
  FACE_MOODS,
  FaceMoodSchema,
  type AvatarTimelineSegment,
  type ProductionPayload,
  type TimedCaptionWord,
} from '../../types/manifest.ts';
import type { TopicCandidate } from '../intelligence/analyzer.ts';

/**
 * Scripting & manifest compilation (pipeline Step 2).
 *
 * The LLM writes a *draft* — narration split into emotional segments plus the
 * carousel copy — and nothing else. Everything that must be exact (frame
 * numbers, word timings, asset names, channel ids) is computed here from the
 * draft, so a creative model never has to be trusted with arithmetic.
 *
 * Provider: `claude -p` (headless Claude Code CLI). Set CF_SCRIPT_PROVIDER=template
 * to use the deterministic fallback for smoke tests without an LLM.
 */

export const ScriptDraftSchema = z.object({
  hook: z.string().min(8).max(140),
  segments: z
    .array(
      z.object({
        text: z.string().min(3),
        body: BodyPoseSchema,
        face: FaceMoodSchema,
      }),
    )
    .min(3)
    .max(12),
  carousel: z
    .array(
      z.object({
        tag: z.string().max(40).optional(),
        headline: z.string().min(1).max(120),
        content: z.string().max(520),
        accentPhrase: z.string().max(160).optional(),
      }),
    )
    .min(3)
    .max(10),
  caption: z.string().min(20).max(2000),
  hashtags: z.array(z.string().min(2).max(40)).max(20),
});

export type ScriptDraft = z.infer<typeof ScriptDraftSchema>;

// ---------------------------------------------------------------------------
// Prompting
// ---------------------------------------------------------------------------

export function buildPrompt(topic: TopicCandidate, config: AppConfig): string {
  const { script, niche } = config;
  const targetWords = Math.round(script.targetDurationSeconds * script.wordsPerSecond);
  return [
    `Ты — сценарист коротких вертикальных видео для ниши «${niche.title}» (язык: русский).`,
    `Тема и доказанный хук конкурента (перепиши своими словами, не копируй дословно):`,
    `  Хук: ${topic.hook}`,
    `  Тип хука: ${topic.hookType}`,
    `  Заголовок источника: ${topic.title}`,
    topic.transcriptExcerpt ? `  Фрагмент транскрипта: ${topic.transcriptExcerpt}` : '',
    ``,
    `Задача: написать сценарий на ${script.minDurationSeconds}–${script.maxDurationSeconds} секунд (~${targetWords} слов) и карусель из ${script.carouselSlides.min}–${script.carouselSlides.max} слайдов на ту же тему.`,
    ``,
    `Правила:`,
    `- Первые 2 секунды — хук, останавливающий скролл. Одна главная мысль на весь ролик.`,
    `- Никаких обещаний вылечить, никаких «отмени назначения врача». Запрещённые темы: ${niche.bannedTopics.join('; ') || 'нет'}.`,
    `- Если упоминаются БАДы — без обещаний результата (ст. 25 ФЗ «О рекламе»).`,
    `- Разбей озвучку на 4–9 сегментов; для каждого укажи позу и эмоцию аватара.`,
    `  Допустимые позы: ${BODY_POSES.join(', ')}. Допустимые эмоции: ${FACE_MOODS.join(', ')}. Ничего другого.`,
    `- Слайд 1 карусели — хук, последний — итог с призывом сохранить. Заголовок ≤ 90 символов, текст ≤ 420 символов.`,
    `- Подпись к посту 300–900 символов, живой человеческий тон, без воды. 8–15 хэштегов без решётки.`,
    `- Без эмодзи и markdown нигде: ни в озвучке, ни на слайдах, ни в подписи (шрифты слайдов их не рисуют, а озвучка читает вслух).`,
    `- Числа в озвучке писать словами («три шага», не «3 шага»), чтобы синтез читал их естественно.`,
    ``,
    `Ответь СТРОГО одним JSON-объектом без markdown и пояснений, схема:`,
    `{"hook": string, "segments": [{"text": string, "body": string, "face": string}], "carousel": [{"tag"?: string, "headline": string, "content": string, "accentPhrase"?: string}], "caption": string, "hashtags": string[]}`,
  ]
    .filter((line) => line !== '')
    .join('\n');
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced?.[1] ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object in model output');
  return JSON.parse(candidate.slice(start, end + 1));
}

async function draftViaClaude(prompt: string): Promise<ScriptDraft> {
  if (!(await which('claude'))) {
    throw new Error('claude CLI not found. Install Claude Code or set CF_SCRIPT_PROVIDER=template.');
  }
  const args = ['-p', prompt, '--output-format', 'text'];
  const model = process.env.CF_CLAUDE_MODEL;
  if (model) args.push('--model', model);

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const result = await run('claude', args, { timeoutMs: 6 * 60 * 1000, allowFailure: true });
    if (result.code !== 0) {
      lastError = new Error(`claude -p exited ${result.code}: ${result.stderr.slice(-800)}`);
      continue;
    }
    try {
      const parsed = ScriptDraftSchema.safeParse(extractJson(result.stdout));
      if (parsed.success) return parsed.data;
      lastError = new Error(
        `draft failed schema: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
      );
    } catch (err) {
      lastError = err as Error;
    }
    log.warn('script draft rejected, retrying', { attempt, error: lastError.message.slice(0, 200) });
  }
  throw lastError ?? new Error('claude -p produced no usable draft');
}

/** Deterministic stand-in so the whole pipeline can be exercised without an LLM. */
export function draftViaTemplate(topic: TopicCandidate): ScriptDraft {
  const subject = topic.keywords.slice(0, 3).join(', ') || 'эта тема';
  return {
    hook: topic.hook.length <= 140 ? topic.hook : topic.hook.slice(0, 137) + '…',
    segments: [
      { text: `${topic.hook}`, body: 'pointing', face: 'surprised' },
      { text: `Сейчас объясню, почему про ${subject} говорят все, и что здесь правда.`, body: 'idle', face: 'neutral' },
      { text: `Первое. Большинство ошибается в самом начале и не смотрит на исходные данные.`, body: 'thinking', face: 'skeptical' },
      { text: `Второе. Работает не «волшебная таблетка», а последовательность из трёх простых шагов.`, body: 'pointing', face: 'happy' },
      { text: `Третье. Проверьте себя по чек-листу в карусели — она в этом же профиле.`, body: 'hands_on_hips', face: 'happy' },
      { text: `Сохраните, чтобы не потерять, и напишите в комментариях, что проверить следующим.`, body: 'idle', face: 'neutral' },
    ],
    carousel: [
      { tag: 'Сохрани', headline: topic.hook.slice(0, 90), content: `Коротко и по делу про ${subject}.`, accentPhrase: 'Листай — 5 фактов за минуту' },
      { headline: 'Что обычно делают не так', content: 'Начинают с добавок, а не с анализа причин. Так теряются месяцы.' },
      { headline: 'С чего начать', content: 'Сначала базовые анализы и питание, потом всё остальное.' },
      { headline: 'Что реально работает', content: 'Последовательность: сон, белок, движение, и только потом точечная поддержка.' },
      { headline: 'Чек-лист', content: '1. Анализы. 2. Рацион. 3. Режим. 4. Контроль через 4–6 недель.' },
      { tag: 'Итог', headline: 'Сохрани и проверь себя', content: 'Одна привычка в неделю даёт больше, чем всё сразу.', accentPhrase: 'Подпишись — дальше разберём каждый пункт' },
    ],
    caption: `${topic.hook}\n\nРазобрали тему «${subject}» без воды: что не работает, с чего начать и как проверить результат. Сохраняйте, чтобы вернуться, и напишите, какую тему разобрать следующей.`,
    hashtags: ['нутрициолог', 'питание', 'здоровье', 'зож', 'анализы', 'витамины', 'энергия', 'привычки'],
  };
}

// ---------------------------------------------------------------------------
// Draft -> ProductionPayload
// ---------------------------------------------------------------------------

function pickAsset(dir: string, seed: string, extensions: string[]): string {
  const candidates = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => extensions.includes(path.extname(f).toLowerCase())).sort()
    : [];
  if (candidates.length === 0) {
    throw new Error(`No assets in ${dir} (expected ${extensions.join('/')}). See scripts/setup-server.sh.`);
  }
  const hash = createHash('sha1').update(seed).digest();
  return candidates[hash[0]! % candidates.length]!;
}

export function estimateCaptions(text: string, wordsPerSecond: number): TimedCaptionWord[] {
  const words = text.split(/\s+/).filter(Boolean);
  const step = 1 / wordsPerSecond;
  return words.map((word, i) => ({ word, start: Number((i * step).toFixed(3)), end: Number(((i + 1) * step).toFixed(3)) }));
}

/**
 * Map segments onto frames using the real caption timings.
 *
 * The TTS engine tokenizes differently from `split(/\s+/)` (hyphens, numbers,
 * "2-3" vs "2 3"), so segment boundaries are located by cumulative *character*
 * share of the narration rather than by word counts: segment i ends at the
 * caption word whose cumulative length crosses that share. Robust to any
 * tokenizer and still a pure function of its inputs.
 */
export function buildTimeline(
  segments: ScriptDraft['segments'],
  captions: TimedCaptionWord[],
  fps: number,
  totalFrames: number,
): AvatarTimelineSegment[] {
  if (segments.length === 0) return [{ startFrame: 0, endFrame: Math.max(1, totalFrames), body: 'idle', face: 'neutral' }];
  if (captions.length === 0) {
    // No timings at all: split frames evenly so the avatar still moves.
    const per = Math.max(1, Math.floor(totalFrames / segments.length));
    return segments.map((s, i) => ({
      startFrame: i * per,
      endFrame: i === segments.length - 1 ? Math.max(totalFrames, (i + 1) * per) : (i + 1) * per,
      body: s.body,
      face: s.face,
    }));
  }

  const segChars = segments.map((s) => s.text.replace(/\s+/g, '').length);
  const totalChars = segChars.reduce((a, b) => a + b, 0) || 1;
  const capCum: number[] = [];
  let acc = 0;
  for (const c of captions) {
    acc += c.word.replace(/\s+/g, '').length;
    capCum.push(acc);
  }
  const totalCapChars = acc || 1;

  const timeline: AvatarTimelineSegment[] = [];
  let charCursor = 0;
  let lastEnd = 0;

  segments.forEach((segment, i) => {
    charCursor += segChars[i]!;
    const share = charCursor / totalChars;
    // last caption word belonging to this segment
    let idx = capCum.findIndex((cum) => cum / totalCapChars >= share);
    if (idx === -1) idx = captions.length - 1;
    const endWord = captions[idx]!;

    const startFrame = i === 0 ? 0 : lastEnd;
    let endFrame = i === segments.length - 1 ? totalFrames : Math.ceil(endWord.end * fps);
    if (endFrame <= startFrame) endFrame = startFrame + 1;
    timeline.push({ startFrame, endFrame, body: segment.body, face: segment.face });
    lastEnd = endFrame;
  });

  timeline[timeline.length - 1]!.endFrame = Math.max(totalFrames, lastEnd);
  return timeline;
}

export interface CompileOptions {
  runId: string;
  targetDate: string;
  characterId?: string;
  bRollAsset?: string;
  musicTrack?: string;
  postizChannelIds?: string[];
}

export function compileManifest(
  draft: ScriptDraft,
  topic: TopicCandidate,
  config: AppConfig,
  options: CompileOptions,
): { manifest: ProductionPayload; draft: ScriptDraft } {
  const fullText = draft.segments.map((s) => s.text.trim()).join(' ');
  const captions = estimateCaptions(fullText, config.script.wordsPerSecond);
  const estimatedDuration = Number((captions.length / config.script.wordsPerSecond).toFixed(2));
  const totalFrames = Math.ceil(estimatedDuration * config.video.fps);

  const manifest: ProductionPayload = {
    runId: options.runId,
    targetDate: options.targetDate,
    topic: { id: topic.id, hook: draft.hook, category: topic.category },
    script: { fullText, estimatedDuration, captions },
    videoConfig: {
      characterId: options.characterId ?? config.video.defaultCharacterId,
      bRollAsset: options.bRollAsset ?? pickAsset(paths.bRoll, options.runId + ':broll', ['.mp4', '.mov']),
      musicTrack: options.musicTrack ?? pickAsset(paths.music, options.runId + ':music', ['.mp3', '.wav', '.m4a']),
      timeline: buildTimeline(draft.segments, captions, config.video.fps, totalFrames),
    },
    carouselConfig: {
      theme: config.carousel.theme,
      slides: draft.carousel.map((slide, i) => ({ index: i + 1, ...slide })),
    },
    distribution: {
      captionText: draft.caption,
      hashtags: draft.hashtags,
      postizChannelIds: options.postizChannelIds ?? [],
    },
  };
  return { manifest, draft };
}

export async function writeScript(topic: TopicCandidate, config: AppConfig): Promise<ScriptDraft> {
  const provider = process.env.CF_SCRIPT_PROVIDER ?? 'claude';
  log.step(`Scripting via ${provider}`);
  if (provider === 'template') return draftViaTemplate(topic);
  return draftViaClaude(buildPrompt(topic, config));
}
