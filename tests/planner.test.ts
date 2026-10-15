import assert from 'node:assert/strict';
import test from 'node:test';
import {DEFAULT_SETTINGS, type MediaAsset} from '../shared/types.js';
import {gridAnalysis} from '../server/media.js';
import {makePlan} from '../server/planner.js';

const videos: MediaAsset[] = [
  {id: 'a', name: 'A', kind: 'video', url: '/media/a.mp4', duration: 8, score: 82},
  {id: 'b', name: 'B', kind: 'video', url: '/media/b.mp4', duration: 0.25, score: 40},
];

test('plan covers the entire output without gaps and cuts on beats', () => {
  const plan = makePlan(videos, undefined, DEFAULT_SETTINGS, gridAnalysis(16, 120));
  assert.equal(plan.durationInFrames, 480);
  assert.equal(plan.scenes[0].kind, 'title');
  assert.equal(plan.scenes.at(-1)?.kind, 'outro');
  assert.equal(plan.scenes.find((scene) => scene.kind === 'reveal')?.from, plan.revealFrame);
  let cursor = 0;
  for (const scene of plan.scenes) {
    assert.equal(scene.from, cursor);
    assert.ok(scene.duration > 0);
    assert.equal(scene.from % 15, 0);
    cursor += scene.duration;
    if (scene.assetId) {
      assert.ok(scene.playbackRate > 0);
      assert.ok(scene.sourceStart >= 0);
      assert.ok(scene.sourceStart + scene.duration / plan.fps * scene.playbackRate <= (scene.sourceDuration ?? 0) + 0.000001);
    }
  }
  assert.equal(cursor, plan.durationInFrames);
  assert.ok(plan.warnings.some((warning) => warning.includes('sangat pendek')));
});

test('music shorter than the requested duration bounds the complete edit', () => {
  const music: MediaAsset = {id: 'music', name: 'Music', kind: 'audio', url: '/media/music.wav', duration: 7.8};
  const plan = makePlan(videos, music, {...DEFAULT_SETTINGS, aspect: '9:16'}, gridAnalysis(7.8, 120));
  assert.ok(plan.durationInFrames / plan.fps <= music.duration);
  assert.ok(plan.durationInFrames / plan.fps >= 6);
  assert.equal(plan.width, 1080); assert.equal(plan.height, 1920);
  assert.equal(plan.musicUrl, music.url);
  assert.ok(plan.warnings.some((warning) => warning.includes('dipersingkat')));
});

test('unsupported input rejects clearly, and output duration remains within 6–60 seconds', () => {
  assert.throws(() => makePlan([], undefined, DEFAULT_SETTINGS, gridAnalysis(16, 120)), /video/);
  assert.throws(() => makePlan(videos, {id: 'm', kind: 'audio', name: 'M', url: '/m.wav', duration: 3}, DEFAULT_SETTINGS, gridAnalysis(3, 120)), /6 detik/);
  for (const duration of [-1, 6, 11, 60, 200]) {
    const plan = makePlan(videos, undefined, {...DEFAULT_SETTINGS, duration, sfx: false}, gridAnalysis(60, 137));
    assert.ok(plan.durationInFrames >= 180 && plan.durationInFrames <= 1800);
    assert.equal(plan.sfxUrl, undefined);
    assert.equal(plan.scenes.reduce((sum, scene) => sum + scene.duration, 0), plan.durationInFrames);
  }
});

test('irregular detected beats remain the scene boundaries', () => {
  const beats = Array.from({length: 33}, (_, i) => i * 0.5 + 0.07);
  const plan = makePlan(videos, undefined, DEFAULT_SETTINGS, {beats, waveform: [], bpm: 120, confidence: 0.9, source: 'detected'});
  const frames = new Set(beats.map((second) => Math.round(second * 30)));
  for (const scene of plan.scenes.slice(1)) assert.ok(frames.has(scene.from));
});

test('an analysis window ending exactly on the next beat preserves the requested duration', () => {
  const analysis = {...gridAnalysis(16, 120), source: 'detected' as const, confidence: 0.9};
  analysis.beats = analysis.beats.filter((beat) => beat < 16);
  const plan = makePlan(videos, undefined, DEFAULT_SETTINGS, analysis);
  assert.equal(plan.durationInFrames, 480);
  const offBeat = makePlan(videos, undefined, {...DEFAULT_SETTINGS, duration: 15.8}, analysis);
  assert.equal(offBeat.durationInFrames, 465);
});
