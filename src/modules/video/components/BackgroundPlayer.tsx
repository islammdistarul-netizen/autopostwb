import React from 'react';
import { AbsoluteFill, Loop, OffthreadVideo, staticFile, useVideoConfig } from 'remotion';
import { PUBLIC_PATHS } from '../props.ts';

/**
 * Looping B-roll layer with soft contrast filters.
 *
 * OffthreadVideo decodes via FFmpeg on the render side instead of the Chromium
 * <video> tag, which is the difference between a stable 2-worker render and CDP
 * timeouts on a small server. The <Loop> length comes from calculateMetadata
 * (b-roll duration) so looping never depends on a hardcoded clip length.
 */

interface Props {
  asset: string;
  durationSeconds: number;
}

export const BackgroundPlayer: React.FC<Props> = ({ asset, durationSeconds }) => {
  const { fps } = useVideoConfig();
  const loopFrames = Math.max(fps, Math.floor(durationSeconds * fps));

  return (
    <AbsoluteFill>
      <Loop durationInFrames={loopFrames}>
        <OffthreadVideo
          src={staticFile(`${PUBLIC_PATHS.bRoll}/${asset}`)}
          muted
          style={{
            width: '100%',
            height: '100%',
            objectFit: 'cover',
            filter: 'brightness(0.62) contrast(1.05) saturate(0.85)',
          }}
        />
      </Loop>
      {/* Subtle vignette keeps white captions readable on bright footage. */}
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(ellipse at center, rgba(0,0,0,0) 45%, rgba(0,0,0,0.55) 100%), linear-gradient(180deg, rgba(0,0,0,0.35) 0%, rgba(0,0,0,0) 30%, rgba(0,0,0,0) 70%, rgba(0,0,0,0.45) 100%)',
        }}
      />
    </AbsoluteFill>
  );
};
