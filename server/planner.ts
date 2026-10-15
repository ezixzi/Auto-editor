import {randomUUID} from 'node:crypto';
import type {BeatAnalysis, EditPlan, EditorSettings, MediaAsset, Scene} from '../shared/types.js';
import {gridAnalysis} from './media.js';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

export function makePlan(assets: MediaAsset[], music: MediaAsset | undefined, settings: EditorSettings, analysis: BeatAnalysis): EditPlan {
  const videos = assets.filter((asset) => asset.kind === 'video' && Number.isFinite(asset.duration) && asset.duration >= 0.1)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  if (!videos.length) throw new Error('Tambahkan setidaknya satu video untuk membuat edit.');
  const fps = 30;
  const requestedDuration = clamp(Number.isFinite(settings.duration) ? settings.duration : 16, 6, 60);
  const warnings: string[] = [];
  if (music && (!Number.isFinite(music.duration) || music.duration < 6)) throw new Error('Musik harus berdurasi setidaknya 6 detik.');
  let duration = Math.min(requestedDuration, music?.duration ?? requestedDuration);
  if (duration < requestedDuration) warnings.push('Durasi edit dipersingkat agar sesuai panjang musik.');
  const usableAnalysis = analysis.beats.some((beat) => Number.isFinite(beat) && beat >= 0 && beat <= duration) ? analysis : gridAnalysis(duration, settings.bpm);
  if (usableAnalysis.source === 'grid') warnings.push(music ? 'Ketukan belum terdeteksi dengan yakin; timeline memakai grid BPM manual.' : 'Belum ada musik; timeline memakai grid BPM manual.');
  const beatFrames = [...new Set(usableAnalysis.beats.filter((beat) => Number.isFinite(beat) && beat >= 0 && beat <= duration).map((beat) => Math.round(beat * fps)))].sort((a, b) => a - b);
  const frameLimit = Math.floor(duration * fps);
  const finalBeat = beatFrames.filter((frame) => frame >= 6 * fps && frame <= frameLimit).at(-1);
  const lastBeat = beatFrames.filter((frame) => frame <= frameLimit).at(-1);
  const expectedBeatFrames = 60 / clamp(usableAnalysis.bpm || settings.bpm || 120, 40, 240) * fps;
  // An analysis window excludes the sample at its exact endpoint. When that
  // endpoint is the next pulse, preserve it instead of losing a whole beat.
  const endsOnNextBeat = beatFrames.length >= 3 && lastBeat !== undefined
    && Math.abs(lastBeat + expectedBeatFrames - frameLimit) <= 1;
  const durationInFrames = endsOnNextBeat ? frameLimit : finalBeat ?? frameLimit;
  duration = durationInFrames / fps;
  const edges = [...new Set([0, ...beatFrames.filter((frame) => frame > 0 && frame < durationInFrames), durationInFrames])];
  const nearest = (target: number, min: number, max: number) => {
    const available = edges.filter((frame) => frame >= min && frame <= max);
    if (!available.length) return Math.round(clamp(target, min, max));
    return available.reduce((best, frame) => Math.abs(frame - target) < Math.abs(best - target) ? frame : best, available[0]);
  };
  const titleEnd = nearest(Math.min(2, duration * 0.13) * fps, 15, durationInFrames * 0.3);
  const outroStart = nearest(durationInFrames - Math.min(2.5, duration * 0.14) * fps, durationInFrames * 0.75, durationInFrames - 15);
  const revealStart = nearest(outroStart - Math.min(7, Math.max(1.5, duration * 0.25)) * fps, titleEnd + 15, outroStart - 15);
  const scenes: Scene[] = [];
  const base = (kind: Scene['kind'], from: number, end: number, label: string): Scene => ({id: randomUUID(), kind, from, duration: end - from, sourceStart: 0, playbackRate: 1, label});
  scenes.push({...base('title', 0, titleEnd, 'Opening'), headline: settings.title, subtitle: ''});
  const beatLength = 60 / clamp(usableAnalysis.bpm || settings.bpm || 120, 40, 240) * fps;
  const pace = [2, 1, 1, 2, 1, 3];
  const paceScale = Math.max(1, Math.round(duration / 24));
  let cursor = titleEnd, clipIndex = 0;
  const applyVideo = (scene: Scene, asset: MediaAsset, desiredRate: number, index: number): Scene => {
    const seconds = scene.duration / fps;
    const safeDuration = Math.max(0.02, asset.duration - 1 / fps);
    const rate = Math.min(desiredRate, safeDuration / seconds);
    // Keep the longest and highest-scoring footage for the reveal; small source
    // clips slow down rather than silently reading beyond their final frame.
    if (rate < 0.35 && !warnings.includes('Beberapa sumber sangat pendek; playback diperlambat agar durasinya cukup.')) warnings.push('Beberapa sumber sangat pendek; playback diperlambat agar durasinya cukup.');
    if (rate < 1 / 16 && !warnings.includes('Sumber yang sangat pendek ditahan sebagai still frame pada shot panjang.')) warnings.push('Sumber yang sangat pendek ditahan sebagai still frame pada shot panjang.');
    const room = Math.max(0, safeDuration - seconds * rate);
    const sourceStart = room * (scene.kind === 'reveal' ? 0.5 : [0.1, 0.45, 0.75][index % 3]);
    return {...scene, assetId: asset.id, src: asset.url, sourceStart, sourceDuration: asset.duration, playbackRate: rate};
  };
  while (cursor < revealStart) {
    const target = Math.min(revealStart, cursor + pace[clipIndex % pace.length] * paceScale * beatLength);
    let end = nearest(target, cursor + 1, revealStart);
    if (end <= cursor) end = revealStart;
    const asset = videos[clipIndex % videos.length];
    scenes.push(applyVideo(base('clip', cursor, end, `Detail ${clipIndex + 1}`), asset, [1.2, 1.5, 1, 0.8][clipIndex % 4], clipIndex));
    cursor = end; clipIndex++;
  }
  const revealAsset = [...videos].sort((a, b) => (b.score ?? 50) + Math.min(10, b.duration) * 2 - ((a.score ?? 50) + Math.min(10, a.duration) * 2))[0];
  scenes.push({...applyVideo(base('reveal', revealStart, outroStart, 'The reveal'), revealAsset, 0.65, 0), headline: settings.subtitle});
  scenes.push({...base('outro', outroStart, durationInFrames, 'Closing'), headline: settings.title, subtitle: settings.subtitle});
  const dimensions = settings.aspect === '9:16' ? [1080, 1920] : settings.aspect === '1:1' ? [1080, 1080] : [1920, 1080];
  return {
    id: randomUUID(), fps, width: dimensions[0], height: dimensions[1], durationInFrames,
    settings: {...settings, duration, bpm: usableAnalysis.bpm}, analysis: usableAnalysis,
    scenes, musicUrl: music?.url, sfxUrl: settings.sfx ? '/media/tap.wav' : undefined,
    revealFrame: revealStart, warnings,
  };
}
