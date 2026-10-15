import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {chromium, type Browser} from 'playwright';
import type {EditPlan, MediaAsset, RenderJob} from '../shared/types.js';
import {DEFAULT_SETTINGS} from '../shared/types.js';
import {runMedia} from '../server/media.js';

const root = process.cwd();
const data = await mkdtemp(path.join(os.tmpdir(), 'forma-e2e-'));
const port = 3101;
const base = `http://127.0.0.1:${port}`;
const screenshots = path.join(root, '.cache', 'e2e');
await mkdir(screenshots, {recursive: true});
let logs = '';
let browser: Browser | undefined;
const server = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], {
  cwd: root, env: {...process.env, NODE_ENV: 'production', PORT: String(port), AUTO_EDITOR_DATA_DIR: data},
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', value => {logs = (logs + value).slice(-16000);});
server.stderr.on('data', value => {logs = (logs + value).slice(-16000);});
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function request<T>(route: string, body?: unknown): Promise<T> {
  const response = await fetch(base + route, body === undefined ? undefined : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
  const result = await response.json();
  assert.ok(response.ok, `${route}: ${JSON.stringify(result)}`);
  return result as T;
}
try {
  for (let attempt = 0; ; attempt++) {
    try {const response = await fetch(base + '/api/health'); if (response.ok) break;} catch {}
    if (attempt > 80 || server.exitCode !== null) throw new Error(`Test server gagal dimulai: ${logs}`);
    await pause(250);
  }
  assert.deepEqual(await request('/api/health'), {ok: true, ffmpeg: true});
  const {assets} = await request<{assets: MediaAsset[]}>('/api/demo', {});
  assert.equal(assets.filter(asset => asset.kind === 'video').length, 3);
  assert.equal(assets.filter(asset => asset.kind === 'audio').length, 1);
  const videos = assets.filter(asset => asset.kind === 'video');
  const music = assets.find(asset => asset.kind === 'audio')!;
  console.log('PASS demo: 3 playable videos + original music');

  const invalid = new FormData();
  invalid.append('files', new Blob(['this is not a video']), 'bad.mp4');
  assert.equal((await fetch(base + '/api/assets', {method: 'POST', body: invalid})).status, 400);
  const afterInvalid = await request<{assets: MediaAsset[]}>('/api/assets');
  assert.equal(afterInvalid.assets.length, 4);
  const upload = new FormData();
  upload.append('files', new Blob([await readFile(path.join(data, 'media', 'demo-1.mp4'))], {type: 'video/mp4'}), 'my-shot.mp4');
  const uploadResponse = await fetch(base + '/api/assets', {method: 'POST', body: upload});
  assert.equal(uploadResponse.status, 201);
  const uploaded = await uploadResponse.json() as {assets: MediaAsset[]};
  assert.equal(uploaded.assets[0].kind, 'video');
  assert.ok(uploaded.assets[0].duration > 7);
  assert.equal((await fetch(base + uploaded.assets[0].url, {headers: {Range: 'bytes=0-99'}})).status, 206);
  assert.equal((await fetch(base + '/api/plan', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({assetIds: ['unknown'], settings: DEFAULT_SETTINGS})})).status, 400);
  assert.equal((await fetch(base + '/api/demo', {method: 'POST', headers: {Origin: 'https://untrusted.example'}})).status, 403);
  console.log('PASS real upload, byte-range playback, malformed media and invalid IDs rejected');

  const {plan} = await request<{plan: EditPlan}>('/api/plan', {assetIds: videos.map(asset => asset.id), musicId: music.id, settings: {...DEFAULT_SETTINGS, duration: 6}});
  assert.equal(plan.analysis.source, 'detected');
  assert.ok(Math.abs(plan.analysis.bpm - 120) <= 3);
  assert.equal(plan.scenes.at(-1)!.from + plan.scenes.at(-1)!.duration, plan.durationInFrames);
  assert.equal(plan.scenes[0].from, 0);
  for (let index = 1; index < plan.scenes.length; index++) assert.equal(plan.scenes[index].from, plan.scenes[index - 1].from + plan.scenes[index - 1].duration);
  const {plan: portrait} = await request<{plan: EditPlan}>('/api/plan', {assetIds: [uploaded.assets[0].id], settings: {...DEFAULT_SETTINGS, duration: 6, theme: 'white', aspect: '9:16', sfx: false}});
  assert.equal(portrait.width, 1080);
  assert.equal(portrait.height, 1920);
  assert.equal(portrait.analysis.source, 'grid');
  assert.ok(portrait.warnings.length);
  console.log('PASS detected beat timeline + portrait / white / manual BPM fallback');

  const {job: started} = await request<{job: RenderJob}>('/api/render', {planId: plan.id});
  let job = started;
  const start = Date.now();
  while (!['done', 'error', 'cancelled'].includes(job.status)) {
    assert.ok(Date.now() - start < 240_000, `Render timeout: ${JSON.stringify(job)}`);
    await pause(500);
    job = (await request<{job: RenderJob}>(`/api/render/${job.id}`)).job;
  }
  assert.equal(job.status, 'done', job.error || 'Render failed');
  assert.equal(job.progress, 1);
  const output = path.join(data, 'exports', `${job.id}.mp4`);
  const metadata = JSON.parse((await runMedia('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output])).toString());
  assert.equal(metadata.streams.find((stream: {codec_type: string}) => stream.codec_type === 'video').codec_name, 'h264');
  assert.equal(metadata.streams.find((stream: {codec_type: string}) => stream.codec_type === 'audio').codec_name, 'aac');
  assert.ok(Math.abs(Number(metadata.format.duration) - plan.durationInFrames / plan.fps) < 0.15);
  assert.equal((await fetch(base + job.url!)).status, 200);
  const audio = await runMedia('ffmpeg', ['-v', 'error', '-i', output, '-vn', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1']);
  const energy = (from: number, to: number) => {
    let sum = 0, count = 0;
    for (let i = Math.floor(from * 8000); i < Math.min(audio.length / 4, Math.floor(to * 8000)); i++) {sum += audio.readFloatLE(i * 4) ** 2; count++;}
    return Math.sqrt(sum / count);
  };
  assert.ok(energy(1, 2) > 0.005, 'Output music must be audible');
  const reveal = plan.revealFrame / plan.fps;
  assert.ok(energy(reveal - 0.18, reveal - 0.06) < energy(1, 2) * 0.1, 'Pre-reveal audio drop must be present');
  await writeFile(path.join(screenshots, 'validated-demo.mp4'), await readFile(output));
  console.log(`PASS MP4: H.264 + AAC, ${metadata.format.duration}s, audible music and pre-reveal silence`);

  browser = await chromium.launch({executablePath: process.env.CHROME_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox']});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  const pageErrors: string[] = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(base, {waitUntil: 'networkidle'});
  await page.getByTestId('demo-button').click();
  await page.waitForFunction(() => !document.querySelector<HTMLButtonElement>('[data-testid=generate-button]')?.disabled);
  assert.equal(await page.getByTestId('asset-card').count(), 5, 'Demo reload must not duplicate assets');
  await page.getByTestId('duration-input').focus();
  await page.getByTestId('duration-input').press('Home');
  await page.getByTestId('generate-button').click();
  await page.getByTestId('preview-player').waitFor({timeout: 30_000});
  await page.getByRole('button', {name: /Lompat ke adegan 2:/}).waitFor();
  await page.getByRole('button', {name: /Lompat ke adegan 2:/}).click();
  await page.getByRole('button', {name: 'Putar pratinjau', exact: true}).click();
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.readyState >= 2 && video.videoWidth > 0));
  await page.getByRole('button', {name: 'Jeda pratinjau', exact: true}).click();
  await page.locator('.scene-reveal').click();
  const scrubber = page.getByRole('slider', {name: 'Posisi pemutaran video'});
  await scrubber.focus();
  for (let frame = 0; frame < 18; frame++) await scrubber.press('ArrowRight');
  await page.waitForFunction(() => [...document.querySelectorAll('video')].some(video => video.readyState >= 2));
  await page.screenshot({path: path.join(screenshots, 'editor-desktop.png'), fullPage: true});
  await page.getByTestId('export-button').click();
  await page.getByTestId('job-status').waitFor();
  await page.getByRole('button', {name: 'Batalkan', exact: true}).click();
  await page.getByTestId('job-status').waitFor({state: 'hidden'});
  await page.getByTestId('title-input').fill('Designed with intention.');
  assert.equal(await page.getByTestId('export-button').isDisabled(), true, 'Changing settings must invalidate export');
  await page.setViewportSize({width: 390, height: 844});
  await page.screenshot({path: path.join(screenshots, 'editor-mobile.png'), fullPage: true});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'Mobile page must fit viewport');
  await page.reload({waitUntil: 'networkidle'});
  assert.equal(await page.getByTestId('title-input').inputValue(), 'Designed with intention.');
  assert.equal(await page.getByTestId('asset-card').count(), 5);
  assert.deepEqual(pageErrors, []);
  console.log('PASS browser: demo → plan → live Player, export/cancel, stale export prevention, durable library/settings, responsive mobile, zero JS errors');
  console.log(`Artifacts: ${screenshots}`);
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  const kill = setTimeout(() => server.kill('SIGKILL'), 3000);
  kill.unref();
}
