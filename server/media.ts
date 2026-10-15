import {spawn} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import type {BeatAnalysis, MediaAsset} from '../shared/types.js';

// Restrict demuxers as well as protocols: an uploaded playlist must never make
// FFmpeg follow URLs or read other files on the server.
const INPUT_FORMATS = 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mpegts,mp3,wav,flac,ogg,aac,aiff';
const INPUT_GUARDS = ['-protocol_whitelist', 'file', '-format_whitelist', INPUT_FORMATS];

export async function runMedia(command: 'ffmpeg' | 'ffprobe', args: string[], maxBytes = 32 * 1024 * 1024, timeoutMs = 90_000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
    const chunks: Buffer[] = [];
    let length = 0;
    let errors = '';
    let stopped: Error | undefined;
    const timer = setTimeout(() => {
      stopped = new Error(`${command} melebihi batas waktu. Gunakan media yang lebih pendek.`);
      child.kill('SIGKILL');
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      length += chunk.length;
      if (length > maxBytes) {
        stopped = new Error('Hasil decoding media terlalu besar.');
        child.kill('SIGKILL');
      } else chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {errors = (errors + chunk.toString()).slice(-4000);});
    child.on('error', (error) => {clearTimeout(timer); reject(error);});
    child.on('close', (code) => {
      clearTimeout(timer);
      if (stopped) reject(stopped);
      else if (code !== 0) reject(new Error(`${command} gagal memproses media: ${errors.trim().slice(-1200) || `exit ${code}`}`));
      else resolve(Buffer.concat(chunks));
    });
  });
}

function shotScore(frame: Buffer): number {
  if (frame.length !== 64 * 36) return 0;
  let total = 0, squared = 0, center = 0, border = 0, centerCount = 0, borderCount = 0, edges = 0;
  for (let y = 0; y < 36; y++) for (let x = 0; x < 64; x++) {
    const value = frame[y * 64 + x];
    total += value; squared += value * value;
    if (x > 19 && x < 45 && y > 7 && y < 29) {center += value; centerCount++;}
    else {border += value; borderCount++;}
    if (x > 0) edges += Math.abs(value - frame[y * 64 + x - 1]);
  }
  const mean = total / frame.length;
  const contrast = Math.sqrt(Math.max(0, squared / frame.length - mean * mean)) / 100;
  const isolation = Math.abs(center / centerCount - border / borderCount) / 150;
  const calmness = Math.max(0, 1 - edges / frame.length / 28);
  return Math.round(100 * Math.max(0.05, Math.min(1, 0.45 * contrast + 0.35 * isolation + 0.2 * calmness)));
}

export async function probeAsset(filePath: string, id: string, name: string, kind: 'video' | 'audio', url: string): Promise<MediaAsset> {
  const output = await runMedia('ffprobe', ['-v', 'error', ...INPUT_GUARDS, '-show_streams', '-show_format', '-of', 'json', filePath], 1024 * 1024, 20_000);
  const probe = JSON.parse(output.toString()) as {format?: {duration?: string}; streams?: {codec_type: string; width?: number; height?: number; duration?: string; disposition?: {attached_pic?: number}}[]};
  const stream = probe.streams?.find((item) => item.codec_type === kind && !item.disposition?.attached_pic);
  if (!stream) throw new Error(kind === 'video' ? 'Berkas tidak memiliki stream video yang dapat dipakai.' : 'Berkas tidak memiliki stream audio yang dapat dipakai.');
  const duration = Number(probe.format?.duration ?? stream.duration);
  if (!Number.isFinite(duration) || duration < 0.1 || duration > 600) throw new Error('Durasi sumber harus antara 0,1 detik dan 10 menit.');
  const asset: MediaAsset = {id, name, kind, url, duration};
  if (kind === 'video') {
    if (!stream.width || !stream.height || stream.width < 16 || stream.height < 16 || stream.width > 8192 || stream.height > 8192) throw new Error('Resolusi video tidak didukung (16–8192 piksel).');
    asset.width = stream.width; asset.height = stream.height;
    const scores: number[] = [];
    for (const fraction of [0.15, 0.5, 0.8]) {
      const frame = await runMedia('ffmpeg', ['-v', 'error', '-nostdin', '-threads', '1', '-ss', String(duration * fraction), ...INPUT_GUARDS, '-i', filePath, '-map', '0:V:0', '-frames:v', '1', '-vf', 'scale=64:36,format=gray', '-f', 'rawvideo', '-threads', '1', 'pipe:1'], 64 * 36 + 100, 30_000);
      if (frame.length === 64 * 36) scores.push(shotScore(frame));
    }
    if (!scores.length) throw new Error('Frame video tidak dapat didekode.');
    asset.score = Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length);
    const thumbnail = await runMedia('ffmpeg', ['-v', 'error', '-nostdin', '-threads', '1', '-ss', String(duration * 0.3), ...INPUT_GUARDS, '-i', filePath, '-map', '0:V:0', '-frames:v', '1', '-vf', "scale=480:480:force_original_aspect_ratio=decrease", '-f', 'image2pipe', '-vcodec', 'mjpeg', '-threads', '1', 'pipe:1'], 2 * 1024 * 1024, 30_000);
    if (!thumbnail.length) throw new Error('Thumbnail video tidak dapat dibuat.');
    await writeFile(`${filePath}.jpg`, thumbnail);
    asset.thumbnail = `${url}.jpg`;
  }
  return asset;
}

export function gridAnalysis(duration: number, bpm: number): BeatAnalysis {
  const safeBpm = Math.max(40, Math.min(240, Number.isFinite(bpm) ? bpm : 120));
  const safeDuration = Math.max(0, Math.min(600, duration));
  return {beats: Array.from({length: Math.floor(safeDuration / (60 / safeBpm)) + 1}, (_, i) => Number((i * 60 / safeBpm).toFixed(5))), waveform: [], bpm: safeBpm, confidence: 0, source: 'grid'};
}

// Analyze decoded samples, not filenames or user BPM. RMS novelty detects
// transients; autocorrelation estimates pulse and onset energy chooses phase.
export function analyzeSamples(samples: Float32Array, sampleRate: number, duration: number, fallbackBpm: number): BeatAnalysis {
  const hop = Math.max(1, Math.round(sampleRate * 0.01));
  const count = Math.ceil(samples.length / hop);
  const rms = new Float64Array(count);
  for (let index = 0; index < count; index++) {
    let energy = 0;
    const end = Math.min(samples.length, (index + 1) * hop);
    for (let sample = index * hop; sample < end; sample++) energy += samples[sample] ** 2;
    rms[index] = Math.sqrt(energy / Math.max(1, end - index * hop));
  }
  const peak = Math.max(0.000001, ...Array.from(rms.slice(0, 60_001)));
  const waveform = Array.from({length: Math.min(180, count)}, (_, index) => {
    const start = Math.floor(index * count / Math.min(180, count));
    const end = Math.max(start + 1, Math.floor((index + 1) * count / Math.min(180, count)));
    let value = 0;
    for (let i = start; i < end; i++) value = Math.max(value, rms[i] ?? 0);
    return Number((value / peak).toFixed(4));
  });
  const fallback = {...gridAnalysis(duration, fallbackBpm), waveform};
  if (count < 150 || peak < 0.002) return fallback;
  const novelty = new Float64Array(count);
  let noveltySum = 0;
  for (let index = 0; index < count; index++) {
    let previous = 0;
    for (let j = Math.max(0, index - 8); j < index; j++) previous += rms[j];
    previous /= Math.max(1, Math.min(8, index));
    novelty[index] = Math.max(0, rms[index] - previous * 1.12);
    noveltySum += novelty[index];
  }
  if (noveltySum < count * peak * 0.002) return fallback;
  const minLag = Math.round(60 / 200 / 0.01), maxLag = Math.round(60 / 65 / 0.01);
  let bestLag = 0, bestScore = 0;
  const candidates: {lag: number; score: number}[] = [];
  for (let lag = minLag; lag <= maxLag; lag++) {
    let cross = 0, left = 0, right = 0;
    for (let index = lag; index < count; index++) {
      cross += novelty[index] * novelty[index - lag];
      left += novelty[index] ** 2; right += novelty[index - lag] ** 2;
    }
    const score = cross / Math.max(1e-12, Math.sqrt(left * right));
    candidates.push({lag, score});
    if (score > bestScore) {bestLag = lag; bestScore = score;}
  }
  if (bestScore < 0.15) return fallback;
  // Resolve close metrical alternatives toward normal music tempo.
  const comparable = candidates.filter((item) => item.score >= bestScore * 0.95);
  comparable.sort((a, b) => Math.abs(60 / (a.lag * 0.01) - 120) - Math.abs(60 / (b.lag * 0.01) - 120));
  bestLag = comparable[0]?.lag ?? bestLag;
  let phase = 0, phaseEnergy = -1;
  for (let candidate = 0; candidate < bestLag; candidate++) {
    let energy = 0;
    for (let index = candidate; index < count; index += bestLag) energy += (novelty[index] ?? 0) + (novelty[index - 1] ?? 0) * 0.6 + (novelty[index + 1] ?? 0) * 0.6;
    if (energy > phaseEnergy) {phaseEnergy = energy; phase = candidate;}
  }
  const beats: number[] = [];
  for (let index = phase; index < count; index += bestLag) {
    let local = index;
    for (let candidate = Math.max(0, index - 3); candidate <= Math.min(count - 1, index + 3); candidate++) if (novelty[candidate] > novelty[local]) local = candidate;
    const second = Number((local * hop / sampleRate).toFixed(5));
    if (second <= duration && (!beats.length || second > beats[beats.length - 1])) beats.push(second);
  }
  return {beats, waveform, bpm: Math.round(60 / (bestLag * hop / sampleRate)), confidence: Number(Math.min(0.98, bestScore).toFixed(3)), source: 'detected'};
}

export async function analyzeAudio(filePath: string, duration: number, fallbackBpm: number): Promise<BeatAnalysis> {
  const sampleRate = 8000;
  const decoded = await runMedia('ffmpeg', ['-v', 'error', '-nostdin', '-threads', '1', ...INPUT_GUARDS, '-i', filePath, '-map', '0:a:0', '-t', String(Math.min(600, duration)), '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 'f32le', '-threads', '1', 'pipe:1'], 600 * sampleRate * 4 + 4096, 90_000);
  if (decoded.length < 4) throw new Error('Audio tidak dapat didekode.');
  const samples = new Float32Array(decoded.length / 4);
  for (let i = 0; i < samples.length; i++) samples[i] = decoded.readFloatLE(i * 4);
  return analyzeSamples(samples, sampleRate, Math.min(duration, samples.length / sampleRate), fallbackBpm);
}
