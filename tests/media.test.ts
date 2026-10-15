import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {analyzeAudio, analyzeSamples, probeAsset, runMedia} from '../server/media.js';

test('audio onset analysis detects a real 120 BPM pulse instead of the supplied fallback', () => {
  const rate = 8000, duration = 12, samples = new Float32Array(rate * duration);
  for (let beat = 0.05; beat < duration; beat += 0.5) {
    for (let i = 0; i < rate * 0.12; i++) {
      const position = Math.floor(beat * rate) + i;
      if (position < samples.length) samples[position] = Math.sin(i / rate * Math.PI * 2 * 90) * Math.exp(-i / rate * 35) * 0.8;
    }
  }
  const analysis = analyzeSamples(samples, rate, duration, 85);
  assert.equal(analysis.source, 'detected');
  assert.ok(Math.abs(analysis.bpm - 120) <= 2);
  assert.ok(analysis.confidence > 0.5);
  assert.ok(analysis.beats.length >= 22);
  assert.ok(Math.abs(analysis.beats[0] - 0.05) < 0.04);
  assert.equal(analysis.waveform.length, 180);
});

test('silence returns an explicit manual grid with zero confidence', () => {
  const analysis = analyzeSamples(new Float32Array(8000 * 6), 8000, 6, 90);
  assert.equal(analysis.source, 'grid'); assert.equal(analysis.bpm, 90); assert.equal(analysis.confidence, 0);
  assert.ok(analysis.waveform.every((value) => value === 0));
});

test('actual FFmpeg media validation, thumbnails, audio decoding and bad inputs', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'forma-media-'));
  try {
    const video = path.join(directory, 'sample.mp4');
    await runMedia('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=30:d=1.2', '-vf', 'drawbox=x=55:y=20:w=50:h=50:color=white:t=fill', '-c:v', 'libx264', '-threads', '1', '-pix_fmt', 'yuv420p', video]);
    const asset = await probeAsset(video, 'sample', 'sample', 'video', '/media/sample.mp4');
    assert.equal(asset.width, 160); assert.equal(asset.height, 90);
    assert.ok(asset.duration >= 1.1); assert.ok((asset.score ?? 0) > 20);
    assert.equal(asset.thumbnail, '/media/sample.mp4.jpg');
    assert.ok((await readFile(`${video}.jpg`)).length > 100);
    await assert.rejects(() => probeAsset(video, 'bad', 'bad', 'audio', '/media/sample.mp4'), /audio/);
    const audio = path.join(directory, 'silence.wav');
    await runMedia('ffmpeg', ['-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'anullsrc=r=8000:cl=mono', '-t', '2', audio]);
    const audioAsset = await probeAsset(audio, 'audio', 'audio', 'audio', '/media/silence.wav');
    const analysis = await analyzeAudio(audio, audioAsset.duration, 100);
    assert.equal(analysis.source, 'grid'); assert.equal(analysis.bpm, 100);
    const bad = path.join(directory, 'fake.mp4');
    await writeFile(bad, 'This is not media');
    await assert.rejects(() => probeAsset(bad, 'bad', 'bad', 'video', '/media/fake.mp4'));
    const playlist = path.join(directory, 'playlist.m3u8');
    await writeFile(playlist, '#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nhttp://127.0.0.1:1/private\n#EXT-X-ENDLIST\n');
    await assert.rejects(() => probeAsset(playlist, 'bad', 'bad', 'video', '/media/playlist.m3u8'), /not on whitelist|Invalid data|gagal/);
  } finally {await rm(directory, {recursive: true, force: true});}
});
