import React from 'react';
import { Composition, registerRoot, staticFile, type CalculateMetadataFunction } from 'remotion';
import { getAudioDurationInSeconds, getVideoMetadata } from '@remotion/media-utils';
import { ReelComposition } from './ReelComposition.tsx';
import {
  PUBLIC_PATHS,
  ReelPropsSchema,
  VIDEO_FPS,
  VIDEO_HEIGHT,
  VIDEO_WIDTH,
  type ReelProps,
} from './props.ts';
import { MouthCuesSchema } from '../../types/manifest.ts';
import { CharacterDefinitionSchema } from '../../types/avatar.ts';

/**
 * Remotion entry point.
 *
 * Duration is never hardcoded: calculateMetadata() reads voice.wav from the public
 * dir and derives durationInFrames from its real length, then attaches the mouth
 * cues and sprite index so every component is a pure function of frame + props.
 */

const TAIL_SECONDS = 0.6;

const calculateReelMetadata: CalculateMetadataFunction<ReelProps> = async ({ props }) => {
  const [voiceDurationSeconds, mouthCuesRaw, characterRaw] = await Promise.all([
    getAudioDurationInSeconds(staticFile(PUBLIC_PATHS.voice)),
    fetch(staticFile(PUBLIC_PATHS.mouthCues)).then((r) => r.json()),
    fetch(staticFile(`${PUBLIC_PATHS.characters}/${props.videoConfig.characterId}/character.json`)).then((r) =>
      r.json(),
    ),
  ]);

  const mouthCues = MouthCuesSchema.parse(mouthCuesRaw);
  const character = CharacterDefinitionSchema.parse(characterRaw);

  let bRollDurationSeconds = voiceDurationSeconds;
  try {
    const meta = await getVideoMetadata(staticFile(`${PUBLIC_PATHS.bRoll}/${props.videoConfig.bRollAsset}`));
    if (meta.durationInSeconds > 0) bRollDurationSeconds = meta.durationInSeconds;
  } catch {
    // Missing/odd b-roll metadata: loop over the voice length instead of failing the render.
  }

  const durationInFrames = Math.max(VIDEO_FPS, Math.ceil((voiceDurationSeconds + TAIL_SECONDS) * VIDEO_FPS));

  return {
    durationInFrames,
    fps: VIDEO_FPS,
    width: VIDEO_WIDTH,
    height: VIDEO_HEIGHT,
    props: {
      ...props,
      runtime: {
        mouthCues,
        character,
        voiceDurationSeconds,
        bRollDurationSeconds,
        musicVolume: props.runtime?.musicVolume ?? 0.12,
        voiceVolume: props.runtime?.voiceVolume ?? 1,
      },
    },
  };
};

const DEFAULT_PROPS: ReelProps = {
  runId: 'preview',
  targetDate: '1970-01-01',
  topic: { id: 'preview', hook: 'Превью композиции', category: 'preview' },
  script: {
    fullText: 'Превью композиции без озвучки.',
    estimatedDuration: 5,
    captions: [
      { word: 'Превью', start: 0, end: 0.5 },
      { word: 'композиции', start: 0.5, end: 1.2 },
      { word: 'без', start: 1.2, end: 1.5 },
      { word: 'озвучки.', start: 1.5, end: 2.2 },
    ],
  },
  videoConfig: {
    characterId: 'default',
    bRollAsset: 'default.mp4',
    musicTrack: 'default.mp3',
    timeline: [{ startFrame: 0, endFrame: 150, body: 'idle', face: 'neutral' }],
  },
  carouselConfig: {
    theme: { backgroundColor: '#0E1116', primaryTextColor: '#F5F7FA', accentColor: '#7CF29C', fontFamily: 'Inter' },
    slides: [{ index: 1, headline: 'Превью', content: '' }],
  },
  distribution: { captionText: 'preview', hashtags: [], postizChannelIds: [] },
};

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="ReelComposition"
      component={ReelComposition}
      schema={ReelPropsSchema}
      defaultProps={DEFAULT_PROPS}
      calculateMetadata={calculateReelMetadata}
      width={VIDEO_WIDTH}
      height={VIDEO_HEIGHT}
      fps={VIDEO_FPS}
      durationInFrames={VIDEO_FPS * 5}
    />
  );
};

registerRoot(RemotionRoot);
