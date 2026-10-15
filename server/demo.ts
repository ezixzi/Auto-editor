import {mkdir, stat, writeFile} from 'node:fs/promises';
import path from 'node:path';
import type {MediaAsset} from '../shared/types.js';
import {probeAsset, runMedia} from './media.js';

function wav(samples: Float32Array, sampleRate: number): Buffer {
  const data = Buffer.alloc(44 + samples.length * 2);
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8);
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22);
  data.writeUInt32LE(sampleRate, 24); data.writeUInt32LE(sampleRate * 2, 28);
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36);
  data.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return data;
}

async function exists(filePath: string): Promise<boolean> {
  try {return (await stat(filePath)).size > 100;} catch {return false;}
}

export async function ensureSfx(dataDir: string): Promise<string> {
  await mkdir(dataDir, {recursive: true});
  const filePath = path.join(dataDir, 'tap.wav');
  if (await exists(filePath)) return filePath;
  const sampleRate = 22050, samples = new Float32Array(Math.round(sampleRate * 0.2));
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate;
    samples[i] = 0.32 * Math.exp(-t * 36) * (Math.sin(t * 2 * Math.PI * 1400) * 0.6 + Math.sin(t * 2 * Math.PI * 2197) * 0.4) * Math.min(1, t * 2000);
  }
  await writeFile(filePath, wav(samples, sampleRate));
  return filePath;
}

function music(): Buffer {
  const sampleRate = 22050, duration = 24;
  const samples = new Float32Array(sampleRate * duration);
  let noise = 123456;
  for (let i = 0; i < samples.length; i++) {
    const t = i / sampleRate, beat = Math.floor(t * 2), local = t - beat * 0.5;
    noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0;
    const random = noise / 0xffffffff * 2 - 1;
    const kick = Math.sin(2 * Math.PI * (48 * local + 1.8 * (1 - Math.exp(-local * 30)))) * Math.exp(-local * 20) * 0.55;
    const hat = random * Math.exp(-local * 90) * 0.12;
    const snare = beat % 2 ? random * Math.exp(-local * 28) * 0.13 : 0;
    const notes = [220, 277.18, 329.63, 415.3, 329.63, 277.18, 246.94, 329.63];
    const note = notes[beat % notes.length];
    const glass = (Math.sin(2 * Math.PI * note * 2 * t) + 0.3 * Math.sin(2 * Math.PI * note * 4 * t)) * Math.exp(-local * 7) * 0.055;
    const pad = (Math.sin(2 * Math.PI * 110 * t) + Math.sin(2 * Math.PI * 164.81 * t)) * 0.018;
    const fade = Math.min(1, (duration - t) / 1.3);
    samples[i] = (kick + hat + snare + glass + pad) * fade;
  }
  return wav(samples, sampleRate);
}

const clamp = (n: number) => Math.max(0, Math.min(255, Math.round(n)));
const roundedRect = (x: number, y: number, w: number, h: number, r: number) => Math.hypot(Math.max(Math.abs(x) - w + r, 0), Math.max(Math.abs(y) - h + r, 0)) + Math.min(Math.max(Math.abs(x) - w + r, Math.abs(y) - h + r), 0) - r;

// Original procedural product study. No stock footage, external fonts, or
// third-party brand assets are needed for the built-in end-to-end demo.
function productImage(variant: number): Buffer {
  const width = 960, height = 540;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    let px = x - width / 2, py = y - height / 2;
    const glow = Math.exp(-((px / 320) ** 2 + (py / 240) ** 2));
    let rgb = [2 + glow * 8, 3 + glow * 9, 4 + glow * 11];
    if (variant === 0 || variant === 2) {
      const angle = variant === 0 ? -0.1 : 0.16;
      const rx = px * Math.cos(angle) - py * Math.sin(angle);
      const ry = px * Math.sin(angle) + py * Math.cos(angle);
      px = rx; py = ry;
      const halfWidth = variant === 0 ? 103 : 110, halfHeight = 205;
      const body = roundedRect(px, py, halfWidth, halfHeight, 31);
      if (body < 0) {
        const edge = Math.max(0, 1 + body / 7);
        const reflection = 135 + 65 * Math.cos((px + py * 0.5) / 120) + edge * 55;
        rgb = [reflection, reflection + 3, reflection + 8];
      }
      const glass = roundedRect(px, py, halfWidth - 7, halfHeight - 7, 25);
      if (glass < 0) {
        const orb = Math.hypot(px / 150, (py - 35) / 175);
        const ring = Math.exp(-(((orb - 0.82) / 0.16) ** 2));
        const sphere = Math.max(0, 1 - orb) * 14;
        rgb = [5 + ring * 38 + sphere, 8 + ring * 55 + sphere, 13 + ring * 77 + sphere];
        const reflection = Math.max(0, 1 - Math.abs(px + py * 0.4 + 65) / 30) * 12;
        rgb = rgb.map((value) => value + reflection);
      }
      if (roundedRect(px, py + 182, 24, 5, 5) < 0) rgb = [1, 2, 3];
      if (roundedRect(px, py - 190, 25, 1.5, 1.5) < 0) rgb = [145, 151, 158];
      if (variant === 2 && roundedRect(px - halfWidth - 1, py + 45, 2.5, 20, 2) < 0) rgb = [110, 115, 123];
    } else {
      px += 10; py += 5;
      const rotatedX = px * 0.98 - py * 0.2, rotatedY = px * 0.2 + py * 0.98;
      px = rotatedX; py = rotatedY;
      const body = roundedRect(px, py - 100, 238, 285, 62);
      if (body < 0) {
        const edge = Math.max(0, 1 + body / 8);
        const light = 33 + Math.max(0, 1 - Math.hypot((px + 180) / 580, (py + 170) / 700)) * 75 + edge * 70;
        rgb = [light, light + 4, light + 11];
      }
      const island = roundedRect(px + 48, py + 36, 157, 138, 40);
      if (island < 0) rgb = [45, 49, 57].map((value) => value + Math.max(0, 1 + island / 5) * 56);
      for (const [cx, cy] of [[-116, -99], [18, -31], [-116, 43]]) {
        const dx = px - cx, dy = py - cy, radius = Math.hypot(dx, dy);
        if (radius < 55) {
          const ring = Math.exp(-(((radius - 49) / 2.3) ** 2)) * 165;
          const inner = Math.exp(-(((radius - 38) / 1.5) ** 2)) * 50;
          const glint = Math.exp(-(((dx + 15) / 13) ** 2) - ((dy + 16) / 8) ** 2) * 60;
          rgb = [7 + ring + inner + glint * 0.6, 10 + ring + inner + glint * 0.9, 16 + ring + inner + glint];
        }
      }
      if (Math.hypot(px - 25, py + 124) < 12) rgb = [190, 187, 175];
      if (Math.hypot(px - 27, py - 61) < 12) rgb = [10, 12, 15];
    }
    const index = (y * width + x) * 3;
    pixels[index] = clamp(rgb[0]); pixels[index + 1] = clamp(rgb[1]); pixels[index + 2] = clamp(rgb[2]);
  }
  return Buffer.concat([Buffer.from(`P6\n${width} ${height}\n255\n`), pixels]);
}

let demoPromise: Promise<MediaAsset[]> | undefined;
let demoDirectory: string | undefined;
export async function createDemo(dataDir: string): Promise<MediaAsset[]> {
  if (demoPromise && demoDirectory === dataDir) return demoPromise;
  demoDirectory = dataDir;
  demoPromise = buildDemo(dataDir).catch((error) => {demoPromise = undefined; throw error;});
  return demoPromise;
}

async function buildDemo(dataDir: string): Promise<MediaAsset[]> {
  await mkdir(dataDir, {recursive: true});
  await ensureSfx(dataDir);
  const results: MediaAsset[] = [];
  const shots = ['Silhouette', 'Precision', 'The reveal'];
  for (let index = 0; index < shots.length; index++) {
    const fileName = `demo-${index + 1}.mp4`, filePath = path.join(dataDir, fileName);
    if (!await exists(filePath)) {
      const imagePath = path.join(dataDir, `demo-${index + 1}.ppm`);
      await writeFile(imagePath, productImage(index));
      await runMedia('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-threads', '1', '-loop', '1', '-i', imagePath, '-vf', "zoompan=z='1+0.045*(1-cos(on/240*PI))/2':x='iw/2-iw/zoom/2':y='ih/2-ih/zoom/2':d=1:s=960x540:fps=30,format=yuv420p", '-t', '8', '-an', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-threads', '2', '-movflags', '+faststart', filePath], 1024 * 1024, 90_000);
    }
    results.push(await probeAsset(filePath, `demo-video-${index + 1}`, `${String(index + 1).padStart(2, '0')} · ${shots[index]}`, 'video', `/media/${fileName}`));
  }
  const audioPath = path.join(dataDir, 'demo-music.wav');
  if (!await exists(audioPath)) await writeFile(audioPath, music());
  results.push(await probeAsset(audioPath, 'demo-music', 'Form · original beat / 120 BPM', 'audio', '/media/demo-music.wav'));
  return results;
}
