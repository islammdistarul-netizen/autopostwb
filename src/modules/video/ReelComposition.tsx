import React from 'react';
import { AbsoluteFill, Audio, staticFile } from 'remotion';
import { loadFont } from '@remotion/fonts';
import { Avatar2D } from './components/Avatar2D.tsx';
import { KineticCaptions } from './components/KineticCaptions.tsx';
import { BackgroundPlayer } from './components/BackgroundPlayer.tsx';
import { PUBLIC_PATHS, type ReelProps } from './props.ts';

/**
 * Master timeline synchronizer.
 *
 * Layer order (bottom -> top): looping b-roll, avatar sprite stack, kinetic
 * captions, hook banner. Audio: voice at full volume, music ducked under it.
 * Nothing here reads the clock — every child derives state from useCurrentFrame().
 */

loadFont({
  family: 'Unbounded',
  url: staticFile(`${PUBLIC_PATHS.fonts}/Unbounded-Medium.ttf`),
  weight: '500',
});
loadFont({
  family: 'Inter',
  url: staticFile(`${PUBLIC_PATHS.fonts}/Inter-Bold.ttf`),
  weight: '700',
});

export const ReelComposition: React.FC<ReelProps> = (props) => {
  const { runtime } = props;
  if (!runtime) {
    // Only reachable inside Remotion Studio before calculateMetadata resolves.
    return <AbsoluteFill style={{ backgroundColor: '#0E1116' }} />;
  }

  const accent = props.carouselConfig.theme.accentColor;

  return (
    <AbsoluteFill style={{ backgroundColor: '#000' }}>
      <BackgroundPlayer
        asset={props.videoConfig.bRollAsset}
        durationSeconds={runtime.bRollDurationSeconds}
      />

      <Avatar2D
        character={runtime.character}
        timeline={props.videoConfig.timeline}
        mouthCues={runtime.mouthCues}
      />

      <HookBanner text={props.topic.hook} accent={accent} />

      <KineticCaptions captions={props.script.captions} accent={accent} />

      <Audio src={staticFile(PUBLIC_PATHS.voice)} volume={runtime.voiceVolume} />
      <Audio
        src={staticFile(`${PUBLIC_PATHS.music}/${props.videoConfig.musicTrack}`)}
        volume={runtime.musicVolume}
        loop
      />
    </AbsoluteFill>
  );
};

const HookBanner: React.FC<{ text: string; accent: string }> = ({ text, accent }) => {
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-start', alignItems: 'center', pointerEvents: 'none' }}>
      <div
        style={{
          marginTop: 220,
          maxWidth: 900,
          padding: '22px 34px',
          borderRadius: 28,
          backgroundColor: 'rgba(8, 10, 14, 0.72)',
          border: `3px solid ${accent}`,
          color: '#F5F7FA',
          fontFamily: 'Unbounded, Inter, sans-serif',
          fontWeight: 500,
          fontSize: 50,
          lineHeight: 1.18,
          textAlign: 'center',
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};
