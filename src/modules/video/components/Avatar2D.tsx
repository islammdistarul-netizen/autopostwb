import React from 'react';
import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import type { AvatarTimelineSegment, MouthCues } from '../../../types/manifest.ts';
import { isBlinking, normalizeViseme, resolveSprites, type CharacterDefinition } from '../../../types/avatar.ts';
import { PUBLIC_PATHS } from '../props.ts';

/**
 * Canvas sprite state-machine with spring bounce dynamics.
 *
 * Every frame is a pure lookup:
 *   body/frame <- the manifest's AvatarTimelineSegment covering this frame
 *   face       <- same segment (layered mode only; composite bakes it in)
 *   mouth      <- the Rhubarb cue covering this frame's timestamp
 *   blink      <- deterministic schedule (isBlinking)
 * Only files registered in character.json are ever referenced
 * (CLAUDE.md -> Zero Character Drift); the mouth is never animated by hand.
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
  return { segment: timeline[timeline.length - 1]!, index: timeline.length - 1 };
}

function visemeAt(mouthCues: MouthCues, seconds: number): string {
  // Cues are contiguous and sorted; a linear scan on ~300 cues is trivially deterministic.
  for (const cue of mouthCues.mouthCues) {
    if (seconds >= cue.start && seconds < cue.end) return cue.value;
  }
  return 'X';
}

const overlayStyle = (offset: { x: number; y: number }, scale: number): React.CSSProperties => ({
  position: 'absolute',
  left: '50%',
  top: '50%',
  transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
});

export const Avatar2D: React.FC<Props> = ({ character, timeline, mouthCues }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const { segment, index } = segmentAt(timeline, frame);
  const viseme = normalizeViseme(visemeAt(mouthCues, frame / fps));
  const blinking = isBlinking(frame, fps, character.motion);
  const sprites = resolveSprites(character, segment.body, segment.face, viseme, blinking);

  const base = `${PUBLIC_PATHS.characters}/${character.id}`;
  const src = (rel: string) => staticFile(`${base}/${rel}`);

  // Pose change -> springy pop. Idle -> slow breathing sway. Both pure functions of frame.
  const pop = spring({
    frame: frame - segment.startFrame,
    fps,
    config: { stiffness: character.sprite.bounce.stiffness, damping: character.sprite.bounce.damping, mass: 0.9 },
  });
  const popScale = interpolate(pop, [0, 1], [0.94, 1]);
  const breathe = character.motion.breathe
    ? Math.sin((frame / fps) * Math.PI * 2 * 0.35) * character.sprite.bounce.amplitude * 0.35
    : 0;
  const tilt = character.motion.breathe ? Math.sin((frame / fps) * Math.PI * 2 * 0.2 + index) * 1.2 : 0;

  const { anchor, scale } = character.sprite;
  const { faces, mouths, blink } = character.layers;

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
        <Img src={src(sprites.body)} style={{ display: 'block' }} />
        {sprites.face && faces ? <Img src={src(sprites.face)} style={overlayStyle(faces.offset, faces.scale)} /> : null}
        {sprites.blink && blink ? <Img src={src(sprites.blink)} style={overlayStyle(blink.offset, blink.scale)} /> : null}
        <Img src={src(sprites.mouth)} style={overlayStyle(mouths.offset, mouths.scale)} />
      </div>
    </AbsoluteFill>
  );
};
