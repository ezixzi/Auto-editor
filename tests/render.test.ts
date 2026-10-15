import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import type {AddressInfo} from 'node:net';
import express from 'express';
import {DEFAULT_SETTINGS, type EditPlan} from '../shared/types.js';
import {renderPlan, resolveRenderAssets} from '../server/render.js';
import {getMusicVolume} from '../video/audio.js';

const plan: EditPlan = {
  id: 'test', fps: 30, width: 320, height: 180, durationInFrames: 240,
  settings: {...DEFAULT_SETTINGS, musicVolume: 0.7},
  analysis: {beats: [], waveform: [], bpm: 120, confidence: 0, source: 'grid'},
  scenes: [{
    id: 'source', kind: 'clip', from: 0, duration: 240, src: '/media/source.mp4',
    sourceStart: 2, sourceDuration: 8, playbackRate: 0.5, label: 'Detail',
  }],
  musicUrl: '/media/music.wav', sfxUrl: '/media/tap.wav', revealFrame: 150, warnings: [],
};

test('render assets resolve against the server origin without mutating the plan', () => {
  const resolved = resolveRenderAssets(plan, 'http://127.0.0.1:3000');
  assert.equal(resolved.scenes[0].src, 'http://127.0.0.1:3000/media/source.mp4');
  assert.equal(resolved.musicUrl, 'http://127.0.0.1:3000/media/music.wav');
  assert.equal(resolved.sfxUrl, 'http://127.0.0.1:3000/media/tap.wav');
  assert.equal(plan.scenes[0].src, '/media/source.mp4');
  assert.notEqual(resolved.scenes[0], plan.scenes[0]);
});

test('remote, privileged, and path-traversing render inputs are rejected', () => {
  const forbidden = [
    'https://outside.example/media/clip.mp4', '//outside.example/media/clip.mp4',
    'file:///etc/passwd', 'data:video/mp4;base64,abc',
    '/media/../api/health', '/media/%2e%2e/api/health', '/exports/private.mp4',
    'http://user:password@127.0.0.1:3000/media/source.mp4',
  ];
  for (const src of forbidden) {
    for (const field of ['musicUrl', 'sfxUrl'] as const) {
      assert.throws(() => resolveRenderAssets({...plan, [field]: src}, 'http://127.0.0.1:3000'));
    }
    assert.throws(() => resolveRenderAssets({...plan, scenes: [{...plan.scenes[0], src}]}, 'http://127.0.0.1:3000'));
  }
  assert.throws(() => resolveRenderAssets(plan, 'file:///tmp'));
});

test('cancelled jobs never start bundling or create render progress', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await assert.rejects(
    renderPlan(plan, '/tmp/should-not-render.mp4', 'http://127.0.0.1:3000', () => {calls += 1;}, controller.signal),
    /cancelled/,
  );
  assert.equal(calls, 0);
});

test('the shared music envelope has real silence before the reveal and fades at both ends', () => {
  assert.equal(getMusicVolume(plan, 0), 0);
  assert.equal(getMusicVolume(plan, plan.durationInFrames - 1), 0);
  assert.equal(getMusicVolume(plan, 80), plan.settings.musicVolume);
  for (let frame = plan.revealFrame - 7; frame < plan.revealFrame; frame += 1) {
    assert.equal(getMusicVolume(plan, frame), 0);
  }
  assert.equal(getMusicVolume(plan, plan.revealFrame + 5), plan.settings.musicVolume);
  for (let frame = 0; frame < plan.durationInFrames; frame += 1) {
    const volume = getMusicVolume(plan, frame);
    assert.ok(volume >= 0 && volume <= plan.settings.musicVolume);
    assert.equal(getMusicVolume({...plan, settings: {...plan.settings, musicVolume: 0}}, frame), 0);
  }
});

test('MP4 rendering preserves source offsets and holds unsupported slow playback', {skip: process.env.RUN_RENDER_TESTS !== '1', timeout: 120_000}, async () => {
  const run = promisify(execFile);
  const directory = await mkdtemp(path.join(tmpdir(), 'forma-trim-test-'));
  const app = express();
  app.use('/media', express.static(directory));
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    await run('ffmpeg', [
      '-v', 'error', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'color=c=red:s=96x54:r=30:d=2',
      '-f', 'lavfi', '-i', 'color=c=green:s=96x54:r=30:d=2',
      '-f', 'lavfi', '-i', 'color=c=blue:s=96x54:r=30:d=2',
      '-filter_complex', '[0:v][1:v][2:v]concat=n=3:v=1:a=0[out]',
      '-map', '[out]', '-c:v', 'libx264', '-threads', '2', '-pix_fmt', 'yuv420p',
      path.join(directory, 'source.mp4'),
    ]);
    const output = path.join(directory, 'result.mp4');
    await renderPlan({
      ...plan, durationInFrames: 30, musicUrl: undefined, sfxUrl: undefined,
      scenes: [{...plan.scenes[0], duration: 30, sourceStart: 2.2, sourceDuration: 6}],
    }, output, `http://127.0.0.1:${(server.address() as AddressInfo).port}`, () => {});
    const {stdout} = await run('ffmpeg', [
      '-v', 'error', '-ss', '0.5', '-i', output,
      '-frames:v', '1', '-vf', 'scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], {encoding: 'buffer'});
    // Correct: 2.2 + 0.5 * 0.5 = 2.45 seconds (green).
    // Scaling the trim incorrectly would sample 1.35 seconds (red).
    assert.ok(stdout[1] > stdout[0] + 50 && stdout[1] > stdout[2] + 50,
      `Expected green source region, received RGB ${[...stdout]}`);
    await renderPlan({
      ...plan, durationInFrames: 30, musicUrl: undefined, sfxUrl: undefined,
      scenes: [{...plan.scenes[0], duration: 30, sourceStart: 4.2, sourceDuration: 6, playbackRate: 0.02}],
    }, output, `http://127.0.0.1:${(server.address() as AddressInfo).port}`, () => {});
    const frozen = await run('ffmpeg', [
      '-v', 'error', '-ss', '0.8', '-i', output, '-frames:v', '1', '-vf', 'scale=1:1',
      '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ], {encoding: 'buffer'});
    assert.ok(frozen.stdout[2] > frozen.stdout[0] + 50 && frozen.stdout[2] > frozen.stdout[1] + 50,
      `Expected held blue source frame, received RGB ${[...frozen.stdout]}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, {recursive: true, force: true});
  }
});
