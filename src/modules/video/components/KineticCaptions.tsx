import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import type { TimedCaptionWord } from '../../../types/manifest.ts';

/**
 * Word-by-word karaoke captions with safe margins.
 *
 * Words are grouped into short phrases (<= MAX_WORDS_PER_LINE or a sentence end),
 * one phrase visible at a time; the word being spoken is lifted and tinted with
 * the accent color. Grouping is a pure function of the caption array, so the
 * same frame always renders the same phrase.
 *
 * Safe zone: Instagram/TikTok overlay the bottom ~320px and the right ~140px,
 * so captions sit in the vertical middle band and never exceed 880px width.
 */

interface Props {
  captions: TimedCaptionWord[];
  accent: string;
}

const MAX_WORDS_PER_LINE = 4;
const MAX_CHARS_PER_LINE = 26;

interface Phrase {
  words: TimedCaptionWord[];
  start: number;
  end: number;
}

export function groupIntoPhrases(captions: TimedCaptionWord[]): Phrase[] {
  const phrases: Phrase[] = [];
  let current: TimedCaptionWord[] = [];
  let chars = 0;

  const flush = () => {
    if (current.length === 0) return;
    phrases.push({ words: current, start: current[0]!.start, end: current[current.length - 1]!.end });
    current = [];
    chars = 0;
  };

  for (const word of captions) {
    const nextChars = chars + word.word.length + (current.length ? 1 : 0);
    if (current.length >= MAX_WORDS_PER_LINE || (current.length > 0 && nextChars > MAX_CHARS_PER_LINE)) {
      flush();
    }
    current.push(word);
    chars += word.word.length + 1;
    if (/[.!?…]$/.test(word.word)) flush();
  }
  flush();
  return phrases;
}

export const KineticCaptions: React.FC<Props> = ({ captions, accent }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;

  const phrases = React.useMemo(() => groupIntoPhrases(captions), [captions]);
  const phrase = phrases.find((p) => t >= p.start && t < p.end + 0.15);
  if (!phrase) return null;

  const enter = spring({
    frame: frame - Math.round(phrase.start * fps),
    fps,
    config: { stiffness: 220, damping: 18, mass: 0.6 },
  });
  const phraseScale = interpolate(enter, [0, 1], [0.86, 1]);

  return (
    <AbsoluteFill style={{ justifyContent: 'center', alignItems: 'center', pointerEvents: 'none' }}>
      <div
        style={{
          maxWidth: 880,
          marginTop: -180,
          display: 'flex',
          flexWrap: 'wrap',
          justifyContent: 'center',
          gap: '0 18px',
          transform: `scale(${phraseScale})`,
          fontFamily: 'Inter, sans-serif',
          fontWeight: 700,
          fontSize: 76,
          lineHeight: 1.1,
          textAlign: 'center',
          textTransform: 'uppercase',
          color: '#FFFFFF',
          textShadow: '0 4px 0 rgba(0,0,0,0.85), 0 0 24px rgba(0,0,0,0.9)',
        }}
      >
        {phrase.words.map((word, i) => {
          const active = t >= word.start && t < word.end;
          const spoken = t >= word.end;
          const lift = active ? -10 : 0;
          return (
            <span
              key={`${word.start}-${i}`}
              style={{
                display: 'inline-block',
                transform: `translateY(${lift}px) scale(${active ? 1.08 : 1})`,
                color: active ? accent : spoken ? '#FFFFFF' : 'rgba(255,255,255,0.78)',
              }}
            >
              {word.word}
            </span>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
