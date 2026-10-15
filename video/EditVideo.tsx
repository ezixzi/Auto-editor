import React, { useEffect, useState } from 'react';
import {
  AbsoluteFill, Easing, Freeze, Html5Audio, Html5Video, OffthreadVideo, Sequence,
  cancelRender, continueRender, delayRender, getRemotionEnvironment,
  interpolate, useCurrentFrame, useVideoConfig,
} from 'remotion';
import '@fontsource/inter/400.css';
import '@fontsource/inter/700.css';
import type { EditPlan, Scene } from '../shared/types';
import { getMusicVolume } from './audio';

const easeOut = Easing.bezier(0.16, 1, 0.3, 1);
const easeInOut = Easing.bezier(0.4, 0, 0.2, 1);
const clamped = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const FontGate: React.FC = () => {
  const [handle] = useState(() => delayRender('Loading local Inter fonts'));
  useEffect(() => {
    let active = true;
    Promise.all([
      document.fonts.load('400 16px Inter'),
      document.fonts.load('700 16px Inter'),
    ]).then(() => { if (active) continueRender(handle); }).catch(cancelRender);
    return () => { active = false; continueRender(handle); };
  }, [handle]);
  return null;
};

const TypographyScene: React.FC<{ scene: Scene; plan: EditPlan }> = ({ scene, plan }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const portrait = height > width;
  const headline = scene.headline || plan.settings.title;
  const subtitle = scene.subtitle ?? plan.settings.subtitle;
  const fontSize = Math.min(width * (portrait ? 0.135 : 0.087), height * 0.16)
    * Math.min(1, 35 / Math.max(35, headline.length));
  return (
    <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', padding: width * 0.09 }}>
      <div style={{ width: '100%', textAlign: 'center' }}>
        <div style={{ overflow: 'hidden', padding: '0.1em 0.02em' }}>
          <div style={{
            fontSize, fontWeight: 700, lineHeight: 1.06, letterSpacing: '-0.04em',
            whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', textWrap: 'balance',
            translate: `0 ${interpolate(frame, [0, fps * 0.65], [fontSize * 1.2, 0], { ...clamped, easing: easeOut })}px`,
            opacity: interpolate(frame, [0, fps * 0.3], [0, 1], { ...clamped, easing: easeOut }),
            scale: interpolate(frame, [0, scene.duration], [0.985, 1.012], { ...clamped, easing: easeInOut }),
          }}>
            {headline}
          </div>
        </div>
        {subtitle ? <div style={{
          marginTop: height * 0.045, fontSize: Math.min(width * 0.025, height * 0.035),
          fontWeight: 400, lineHeight: 1.45, letterSpacing: '0.015em',
          opacity: interpolate(frame, [fps * 0.1, fps * 0.7], [0, 0.65], { ...clamped, easing: easeOut }),
          translate: `0 ${interpolate(frame, [fps * 0.1, fps * 0.7], [12, 0], { ...clamped, easing: easeOut })}px`,
        }}>{subtitle}</div> : null}
      </div>
    </AbsoluteFill>
  );
};

const FootageScene: React.FC<{ scene: Scene }> = ({ scene }) => {
  const frame = useCurrentFrame();
  const { fps, width, height } = useVideoConfig();
  const isReveal = scene.kind === 'reveal';
  const Video = getRemotionEnvironment().isRendering ? OffthreadVideo : Html5Video;
  if (!scene.src) return null;
  // trimBefore is a source-frame offset; playbackRate only affects elapsed time.
  // Chromium cannot play below 1/16×. Hold a source frame for extremely short
  // clips, while the surrounding Bezier drift continues to animate.
  const holdFrame = scene.playbackRate < 1 / 16;
  const footage = (
    <Video src={scene.src} trimBefore={Math.round(scene.sourceStart * fps)}
      playbackRate={holdFrame ? 1 : scene.playbackRate} muted pauseWhenBuffering
      style={{display: 'block', width: '100%', height: '100%', objectFit: isReveal ? 'contain' : 'cover'}} />
  );
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{
        alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
        padding: isReveal ? `${height * 0.12}px ${width * 0.07}px ${height * 0.2}px` : 0,
      }}>
        <div style={{width: '100%', height: '100%', scale: interpolate(frame,
          [0, Math.max(1, scene.duration - 1)], isReveal ? [0.985, 1.025] : [1, 1.025],
          {...clamped, easing: easeInOut})}}>
          {holdFrame ? <Freeze frame={0}>{footage}</Freeze> : footage}
        </div>
      </AbsoluteFill>
      {isReveal && scene.headline ? <div style={{
        position: 'absolute', bottom: height * 0.085, left: width * 0.08, right: width * 0.08,
        textAlign: 'center', fontSize: Math.min(width * 0.065, height * 0.075) * Math.min(1, 42 / Math.max(42, scene.headline.length)), fontWeight: 700,
        lineHeight: 1.1, letterSpacing: '-0.035em', textWrap: 'balance', overflowWrap: 'anywhere',
        opacity: interpolate(frame, [0, fps * 0.55], [0, 1], { ...clamped, easing: easeOut }),
        translate: `0 ${interpolate(frame, [0, fps * 0.65], [height * 0.025, 0], { ...clamped, easing: easeOut })}px`,
      }}>{scene.headline}</div> : null}
    </AbsoluteFill>
  );
};

/** This data-driven composition is shared verbatim by the Player and MP4 render. */
export const EditVideo: React.FC<{ plan: EditPlan }> = ({ plan }) => {
  const { fps } = useVideoConfig();
  const dark = plan.settings.theme === 'black';
  return (
    <AbsoluteFill style={{
      backgroundColor: dark ? '#000000' : '#ffffff', color: dark ? '#ffffff' : '#000000',
      fontFamily: 'Inter, Helvetica, Arial, sans-serif', overflow: 'hidden',
    }}>
      <FontGate />
      {plan.scenes.map((scene) => (
        <Sequence key={scene.id} name={scene.label} from={scene.from}
          durationInFrames={scene.duration} premountFor={fps}>
          {scene.kind === 'title' || scene.kind === 'outro'
            ? <TypographyScene scene={scene} plan={plan} />
            : <FootageScene scene={scene} />}
        </Sequence>
      ))}
      {plan.musicUrl ? <Html5Audio
        src={plan.musicUrl}
        volume={(frame) => getMusicVolume(plan, frame)}
        pauseWhenBuffering
      /> : null}
      {plan.settings.sfx && plan.sfxUrl ? plan.scenes
        .filter((scene) => scene.kind === 'title' || scene.kind === 'reveal')
        .map((scene) => <Sequence key={`sfx-${scene.id}`} name="Soft glass tap"
          from={scene.from} durationInFrames={Math.min(scene.duration, Math.ceil(fps * 0.5))}
          premountFor={fps}>
          <Html5Audio src={plan.sfxUrl!} volume={scene.kind === 'reveal' ? 0.38 : 0.2} />
        </Sequence>) : null}
    </AbsoluteFill>
  );
};
