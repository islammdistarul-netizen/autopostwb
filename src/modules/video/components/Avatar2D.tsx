import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { AvatarTimelineSegment, MouthCues } from '../../../types/manifest.ts';
import { normalizeViseme, type CharacterDefinition } from '../../../types/avatar.ts';
import { PUBLIC_PATHS } from '../props.ts';

/**
 * Canvas sprite state-machine with spring bounce dynamics.
 *
 * Three stacked layers — body, face, mouth — each swapped by pure lookups:
 *   body/face  <- the manifest's AvatarTimelineSegment covering this frame
 *   mouth      <- the Rhubarb cue covering this frame's timestamp
 * The mouth is never animated by hand; only registered sprite files are ever
 * referenced (CLAUDE.md -> Zero Character Drift).
 */

interface Props {
  character: CharacterDefinition;
  timeline: AvatarTimelineSegment[];
  mouthCues: MouthCues;
}

function segmentAt(timeline: AvatarTimelineSegment[], frame: number): { segment: AvatarTimelineSegment; index: number } {
  for (let i = 0; i < timeline.length; i += 1) {
    const s = timeline[i]!;
    if (frame >= s.startFrame && frame < s.endFrame) return { segment: s, index: i };
  }
  const last = timeline[timeline.length - 1]!;
  return { segment: last, index: timeline.length - 1 };
}

function visemeAt(mouthCues: MouthCues, seconds: number): string {
  // Cues are contiguous and sorted; a linear scan on ~300 cues is cheaper than
  // anything clever and is trivially deterministic.
  for (const cue of mouthCues.mouthCues) {
    if (seconds >= cue.start && seconds < cue.end) return cue.value;
  }
  return 'X';
}

export const Avatar2D: React.FC<Props> = ({ character, timeline, mouthCues }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const { segment, index } = segmentAt(timeline, frame);
  const viseme = normalizeViseme(visemeAt(mouthCues, frame / fps));
  const isSilent = viseme === 'X';

  const base = `${PUBLIC_PATHS.characters}/${character.id}`;
  const { bodies, faces, mouths } = character.layers;
  const bodySrc = staticFile(`${base}/${bodies.dir}/${bodies[segment.body]}`);
  const faceSrc = staticFile(`${base}/${faces.dir}/${faces[segment.face]}`);
  const mouthSrc = staticFile(`${base}/${mouths.dir}/${isSilent ? mouths.closed : mouths[viseme]}`);

  // Pose change -> springy pop. Idle -> slow breathing sway. Both pure functions of frame.
  const pop = spring({
    frame: frame - segment.startFrame,
    fps,
    config: {
      stiffness: character.sprite.bounce.stiffness,
      damping: character.sprite.bounce.damping,
      mass: 0.9,
    },
  });
  const popScale = interpolate(pop, [0, 1], [0.94, 1]);
  const breathe = Math.sin((frame / fps) * Math.PI * 2 * 0.35) * character.sprite.bounce.amplitude * 0.35;
  const tilt = Math.sin((frame / fps) * Math.PI * 2 * 0.2 + index) * 1.2;

  const { anchor, scale } = character.sprite;

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: anchor.x,
          top: anchor.y + breathe,
          transform: `translate(-50%, -50%) scale(${scale * popScale}) rotate(${tilt}deg)`,
          transformOrigin: 'center bottom',
        }}
      >
        <Img src={bodySrc} style={{ display: 'block' }} />
        <Img
          src={faceSrc}
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: `translate(-50%, -50%) translate(${faces.offset.x}px, ${faces.offset.y}px) scale(${faces.scale})`,
          }}
        />
        <Img
          src={mouthSrc}
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transform: `translate(-50%, -50%) translate(${mouths.offset.x}px, ${mouths.offset.y}px) scale(${mouths.scale})`,
          }}
        />
      </div>
    </AbsoluteFill>
  );
};
