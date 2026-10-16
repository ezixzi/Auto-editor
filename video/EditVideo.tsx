// video/EditVideo.tsx
import React, {useEffect, useMemo, useState} from 'react';
import {
  AbsoluteFill, Easing, Freeze, Html5Audio, Html5Video, OffthreadVideo, Sequence,
  cancelRender, continueRender, delayRender, getRemotionEnvironment,
  interpolate, spring, useCurrentFrame, useVideoConfig,
} from 'remotion';
import '@fontsource/inter/400.css';
import '@fontsource/inter/700.css';
import type {EditPlan} from '../shared/types';
import {getMusicVolume} from './audio';
import {getBeatTimestamps, type BeatAudioData} from './beatDetector';

const easing = Easing.bezier(0.25, 0.1, 0.25, 1);
const tween = {easing, extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const physics = {damping: 22, stiffness: 160, mass: 0.85, overshootClamping: true};
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const orderedBeats = (beats: readonly number[], limit: number) =>
  [...new Set(beats.filter(b => Number.isInteger(b) && b >= 0 && b <= limit))].sort((a, b) => a - b);

export interface VideoClip {
  id?: string;
  src: string;
  sourceStart?: number;
  sourceDuration?: number;
  playbackRate?: number;
  title?: string;
  fit?: 'cover' | 'contain';
}

export function getAutoCuts(videoClips: readonly VideoClip[], beats: readonly number[], beatsPerClip = 2) {
  const boundaries = orderedBeats(beats, Infinity);
  const step = Number.isFinite(beatsPerClip) ? Math.max(1, Math.floor(beatsPerClip)) : 2;
  if (!videoClips.length) return [];
  return boundaries.flatMap((from, i) => i % step || i === boundaries.length - 1 ? [] : [{
    clip: videoClips[(i / step) % videoClips.length],
    from, to: boundaries[Math.min(i + step, boundaries.length - 1)],
  }]);
}

/** Integrate velocity: elapsed time × changing playbackRate would cause jumps. */
export function getSourceFrames(clip: VideoClip, duration: number, fps: number, from: number, beats: readonly number[]) {
  const last = clip.sourceDuration === undefined ? Infinity : Math.max(0, Math.floor(clip.sourceDuration * fps) - 1);
  let source = Math.min(last, Math.max(0, (clip.sourceStart ?? 0) * fps));
  let index = 0;
  return Array.from({length: duration}, (_, frame) => {
    const sample = Math.floor(source);
    const time = from + frame + 0.5;
    while (index + 1 < beats.length && beats[index + 1] <= time) index++;
    const before = beats[index], after = beats[index + 1];
    const phase = after > before ? clamp((time - before) / (after - before)) : 0;
    const rate = beats.length < 2 ? Math.max(0, clip.playbackRate ?? 1)
      : interpolate(phase, [0, 0.55, 0.82, 1], [0.7, 1, 1.3, 0.7], tween);
    source = Math.min(last, source + rate);
    return sample;
  });
}

const FontGate: React.FC = () => {
  const [handle] = useState(() => delayRender('Loading Inter'));
  useEffect(() => {
    Promise.all([document.fonts.load('400 16px Inter'), document.fonts.load('700 16px Inter')])
      .then(() => continueRender(handle)).catch(cancelRender);
    return () => continueRender(handle);
  }, [handle]);
  return null;
};

const Title: React.FC<{headline: string; subtitle?: string; compact?: boolean}> = ({headline, subtitle, compact}) => {
  const frame = useCurrentFrame();
  const {fps, width, height, durationInFrames} = useVideoConfig();
  const entrance = spring({frame, fps, config: physics, durationInFrames: Math.min(24, durationInFrames)});
  const fontSize = Math.min(width * 0.085, height * 0.12) * Math.min(1, 32 / Math.max(32, headline.length));
  return <AbsoluteFill style={{justifyContent: compact ? 'flex-end' : 'center', alignItems: 'center', padding: compact ? '0 12% 7%' : '16%', textAlign: 'center'}}>
    <div style={{maxWidth: '100%', overflow: 'hidden'}}>
      <div style={{fontSize: compact ? fontSize * 0.7 : fontSize, fontWeight: 700, letterSpacing: '0.075em', lineHeight: 1.18,
        overflowWrap: 'anywhere', textWrap: 'balance', translate: `0 ${(1 - entrance) * height * 0.07}px`, scale: 0.96 + entrance * 0.04,
        opacity: interpolate(frame, [0, Math.max(1, fps * 0.4)], [0, 1], tween)}}>{headline}</div>
    </div>
    {!compact && subtitle ? <div style={{marginTop: height * 0.035, maxWidth: '90%', fontSize: fontSize * 0.27, lineHeight: 1.6,
      letterSpacing: '0.06em', translate: `0 ${(1 - entrance) * height * 0.035}px`,
      opacity: interpolate(frame, [0, Math.max(1, fps * 0.5)], [0, 0.65], tween)}}>{subtitle}</div> : null}
  </AbsoluteFill>;
};

const Broll: React.FC<{clip: VideoClip; duration: number; from: number; beats: readonly number[]}> = ({clip, duration, from, beats}) => {
  const frame = useCurrentFrame();
  const {fps, width, height} = useVideoConfig();
  const source = useMemo(() => getSourceFrames(clip, duration, fps, from, beats), [clip, duration, fps, from, beats]);
  const beatIndex = beats.reduce((last, beat, index) => beat <= from + frame ? index : last, -1);
  const elapsed = beatIndex < 0 ? Infinity : from + frame - beats[beatIndex];
  const attack = Math.max(1, Math.round(fps * 0.1));
  const pulse = Number.isFinite(elapsed) ? (elapsed < attack
    ? clamp(spring({frame: elapsed, fps, config: physics, durationInFrames: attack}))
    : 1 - clamp(spring({frame: elapsed - attack, fps, config: physics, durationInFrames: Math.max(1, Math.round(fps * 0.3))}))) : 0;
  const drift = interpolate(frame, [0, Math.max(1, duration - 1)], [0, 1], tween);
  const direction = beatIndex % 2 ? -1 : 1;
  const Video = getRemotionEnvironment().isRendering ? OffthreadVideo : Html5Video;

  return <AbsoluteFill>
    <AbsoluteFill style={{overflow: 'hidden', padding: clip.title ? '8% 8% 18%' : 0}}>
      <div style={{width: '100%', height: '100%', scale: (1 + drift * 0.05) * (1 + pulse * 0.08),
        translate: `${width * (0.006 * drift + 0.008 * pulse * direction)}px ${height * (-0.004 * drift + 0.006 * pulse * direction)}px`}}>
        {/* Frame-accurate retiming; optical-flow-style camera motion without synthesized frames. */}
        <Freeze frame={0}>
          <Video src={clip.src} trimBefore={source[Math.max(0, Math.min(duration - 1, frame))] ?? 0}
            muted playbackRate={1} pauseWhenBuffering
            style={{width: '100%', height: '100%', display: 'block', objectFit: clip.fit ?? 'cover'}} />
        </Freeze>
      </div>
    </AbsoluteFill>
    {clip.title ? <Title headline={clip.title} compact /> : null}
  </AbsoluteFill>;
};

export const AutoCutTimeline: React.FC<{
  videoClips: readonly VideoClip[];
  beatTimestamps?: readonly number[];
  audioData?: BeatAudioData;
  beatsPerClip?: number;
  from?: number;
  to?: number;
}> = ({videoClips, beatTimestamps, audioData, beatsPerClip = 2, from = 0, to}) => {
  const {fps, durationInFrames} = useVideoConfig();
  const beats = useMemo(() => orderedBeats(audioData ? getBeatTimestamps(audioData, fps) : beatTimestamps ?? [], durationInFrames),
    [audioData, beatTimestamps, fps, durationInFrames]);
  const cuts = getAutoCuts(videoClips, beats.filter(beat => beat >= from && beat <= (to ?? durationInFrames)), beatsPerClip);

  return <>{cuts.map(({clip, from: start, to: end}, i) => <Sequence key={`${start}-${i}`} from={start}
    durationInFrames={end - start} premountFor={fps} name={clip.title || `Auto cut ${i + 1}`}>
    <Broll clip={clip} from={start} duration={end - start} beats={beats} />
  </Sequence>)}</>;
};

export const AppleComposition: React.FC<{plan: EditPlan; audioData?: BeatAudioData}> = ({plan, audioData}) => {
  const {fps, durationInFrames} = useVideoConfig();
  // Existing plans carry detected transients; decoded PCM can use the new detector.
  // Manual BPM grids are never promoted to detected audio peaks.
  const beats = useMemo(() => orderedBeats(audioData ? getBeatTimestamps(audioData, fps)
    : plan.analysis.source === 'detected' ? plan.analysis.beats.map(seconds => Math.round(seconds * fps)) : [],
    durationInFrames), [audioData, plan.analysis, fps, durationInFrames]);
  const clips = useMemo(() => plan.scenes.filter(scene => scene.src).map(scene => ({
    id: scene.id, src: scene.src!, sourceStart: scene.sourceStart, sourceDuration: scene.sourceDuration,
    playbackRate: scene.playbackRate, title: scene.kind === 'reveal' ? scene.headline : undefined,
    fit: scene.kind === 'reveal' ? 'contain' as const : 'cover' as const,
  })), [plan.scenes]);
  const snap = (target: number, low: number, high: number) => {
    let best = low;
    for (let i = low + 1; i <= high; i++) if (Math.abs(beats[i] - target) < Math.abs(beats[best] - target)) best = i;
    return best;
  };
  const structured = beats.length >= 4;
  const opening = structured ? snap(plan.scenes.find(s => s.kind === 'title')?.duration ?? fps, 1, beats.length - 3) : 0;
  const closing = structured ? snap(plan.scenes.find(s => s.kind === 'outro')?.from ?? durationInFrames - fps, opening + 2, beats.length - 1) : 0;
  const reveal = structured ? snap(plan.revealFrame, opening + 1, closing - 1) : 0;
  const revealFrame = structured ? beats[reveal] : plan.revealFrame;
  const revealClip = clips.find(clip => clip.title) ?? clips[0];
  const detailClips = clips.filter(clip => !clip.title);
  const dark = plan.settings.theme !== 'white';

  return <AbsoluteFill style={{background: dark ? '#000000' : '#ffffff', color: dark ? '#ffffff' : '#000000', fontFamily: 'Inter, sans-serif', overflow: 'hidden'}}>
    <FontGate />
    {structured ? <>
      <Sequence from={beats[0]} durationInFrames={beats[opening] - beats[0]} premountFor={fps}>
        <Title headline={plan.settings.title} />
      </Sequence>
      <AutoCutTimeline videoClips={detailClips.length ? detailClips : clips} beatTimestamps={beats} from={beats[opening]} to={beats[reveal]} />
      <AutoCutTimeline videoClips={revealClip ? [revealClip] : []} beatTimestamps={beats} from={beats[reveal]} to={beats[closing]} beatsPerClip={beats.length} />
      {beats[closing] < durationInFrames && <Sequence from={beats[closing]} durationInFrames={durationInFrames - beats[closing]} premountFor={fps}>
        <Title headline={plan.settings.title} subtitle={plan.settings.subtitle} />
      </Sequence>}
    </> : beats.length >= 2 ? <AutoCutTimeline videoClips={clips} beatTimestamps={beats} />
      : clips[0] ? <Broll clip={clips[0]} from={0} duration={durationInFrames} beats={beats} />
        : <Title headline={plan.settings.title} subtitle={plan.settings.subtitle} />}
    {plan.musicUrl && <Html5Audio src={plan.musicUrl} pauseWhenBuffering volume={frame => getMusicVolume({...plan, revealFrame}, frame)} />}
    {plan.settings.sfx && plan.sfxUrl && structured && [beats[0], revealFrame].map((at, i) => <Sequence key={at} from={at}
      durationInFrames={Math.min(Math.ceil(fps * 0.5), durationInFrames - at)} premountFor={fps}>
      <Html5Audio src={plan.sfxUrl!} volume={i ? 0.38 : 0.2} />
    </Sequence>)}
  </AbsoluteFill>;
};

// Preserve existing Player and renderer imports.
export const EditVideo = AppleComposition;
