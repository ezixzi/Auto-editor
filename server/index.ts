import express from 'express';
import multer from 'multer';
import {randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, unlink, access} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {z} from 'zod';
import type {EditPlan, MediaAsset, RenderJob} from '../shared/types.js';
import {probeAsset, analyzeAudio, gridAnalysis, runMedia} from './media.js';
import {makePlan} from './planner.js';
import {createDemo, ensureSfx} from './demo.js';
import {renderPlan} from './render.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.AUTO_EDITOR_DATA_DIR || path.join(root, '.data'));
const mediaDir = path.join(dataDir, 'media');
const uploadDir = path.join(dataDir, 'incoming');
const exportDir = path.join(dataDir, 'exports');
await Promise.all([mediaDir, uploadDir, exportDir].map(dir => mkdir(dir, {recursive: true})));
const records = new Map<string, {asset: MediaAsset; file: string}>();
const plans = new Map<string, EditPlan>();
const jobs = new Map<string, RenderJob>();
const controllers = new Map<string, AbortController>();
const manifest = path.join(dataDir, 'assets.json');
try {
  const saved = JSON.parse(await readFile(manifest, 'utf8')) as {asset: MediaAsset; file: string}[];
  for (const item of saved) {
    if (path.basename(item.file) !== item.file) continue;
    try {await access(path.join(mediaDir, item.file)); records.set(item.asset.id, item);} catch { /* deleted local asset */ }
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('Manifest media tidak dapat dimuat; berkas sumber tetap disimpan.');
}
let saveChain = Promise.resolve();
function saveAssets() {
  saveChain = saveChain.catch(() => {}).then(async () => {
    const temporary = `${manifest}.tmp`;
    await writeFile(temporary, JSON.stringify([...records.values()], null, 2));
    await rename(temporary, manifest);
  });
  return saveChain;
}
await runMedia('ffmpeg', ['-version'], 8192, 10_000);
await runMedia('ffprobe', ['-version'], 8192, 10_000);

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.headers.origin) {
    try {if (new URL(req.headers.origin).host !== req.headers.host) return res.status(403).json({error: 'Origin permintaan tidak diizinkan.'});}
    catch {return res.status(403).json({error: 'Origin tidak valid.'});}
  }
  next();
});
app.use(express.json({limit: '32kb'}));
app.use('/media', express.static(mediaDir, {dotfiles: 'deny', maxAge: '1h'}));
app.get('/exports/:file', (req, res) => {
  if (!/^[a-f0-9-]+\.mp4$/.test(req.params.file)) return res.sendStatus(404);
  res.download(path.join(exportDir, req.params.file), 'forma-edit.mp4');
});
app.get('/api/health', (_req, res) => res.json({ok: true, ffmpeg: true}));
app.get('/api/assets', (_req, res) => res.json({assets: [...records.values()].map(value => value.asset)}));

const allowedVideo = new Set(['.mp4', '.mov', '.webm', '.mkv', '.avi']);
const allowedAudio = new Set(['.wav', '.mp3', '.m4a', '.aac', '.ogg', '.flac']);
const upload = multer({
  dest: uploadDir,
  limits: {fileSize: 250 * 1024 * 1024, files: 12, fields: 0},
  fileFilter: (_req, file, callback) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowedVideo.has(ext) || allowedAudio.has(ext)) callback(null, true);
    else callback(new Error('Format tidak didukung. Gunakan MP4, MOV, WebM, MKV, AVI, MP3, WAV, M4A, AAC, OGG, atau FLAC.'));
  },
});
let ingestBusy = false;
app.post('/api/assets', (req, res, next) => {
  if (ingestBusy) return res.status(429).json({error: 'Unggahan sebelumnya masih diproses. Coba lagi sebentar.'});
  ingestBusy = true;
  upload.array('files', 12)(req, res, error => {
    if (error) {ingestBusy = false; return next(error);}
    void (async () => {
      const files = (req.files || []) as Express.Multer.File[];
      const created: string[] = [];
      const added: {asset: MediaAsset; file: string}[] = [];
      try {
        if (!files.length) return res.status(400).json({error: 'Pilih setidaknya satu berkas.'});
        for (const file of files) {
          const id = randomUUID();
          const kind = allowedVideo.has(path.extname(file.originalname).toLowerCase()) ? 'video' : 'audio';
          const name = file.originalname.replace(/[\\/\u0000-\u001f]/g, '').slice(0, 160);
          await probeAsset(file.path, id, name, kind, '/media/check');
          const filename = `${id}${kind === 'video' ? '.mp4' : '.wav'}`;
          const destination = path.join(mediaDir, filename);
          created.push(destination, `${destination}.jpg`);
          const args = ['-v', 'error', '-nostdin', '-y', '-threads', '2', '-protocol_whitelist', 'file', '-format_whitelist', 'mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,mp3,wav,flac,ogg,aac', '-i', file.path];
          if (kind === 'video') args.push('-map', '0:V:0', '-an', '-vf', "scale=w='min(1920,iw)':h='min(1920,ih)':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1", '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-threads', '2', '-movflags', '+faststart');
          else args.push('-map', '0:a:0', '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le');
          args.push(destination);
          await runMedia('ffmpeg', args, 1024 * 1024, 600_000);
          const asset = await probeAsset(destination, id, name, kind, `/media/${filename}`);
          added.push({asset, file: filename});
        }
        for (const record of added) records.set(record.asset.id, record);
        await saveAssets();
        return res.status(201).json({assets: added.map(record => record.asset)});
      } catch (error) {
        for (const record of added) records.delete(record.asset.id);
        await Promise.all(created.map(file => unlink(file).catch(() => {})));
        next(error);
      } finally {
        await Promise.all(files.flatMap(file => [file.path, `${file.path}.jpg`]).map(file => unlink(file).catch(() => {})));
        ingestBusy = false;
      }
    })();
  });
});

let demoPending: Promise<MediaAsset[]> | undefined;
app.post('/api/demo', async (_req, res) => {
  demoPending ??= createDemo(mediaDir).catch(error => {demoPending = undefined; throw error;});
  const assets = await demoPending;
  for (const asset of assets) records.set(asset.id, {asset, file: path.basename(asset.url)});
  await saveAssets();
  res.json({assets});
});
const settingsSchema = z.object({
  title: z.string().trim().min(1).max(80), subtitle: z.string().trim().max(120),
  theme: z.enum(['black', 'white']), aspect: z.enum(['16:9', '9:16', '1:1']),
  duration: z.number().min(6).max(60), bpm: z.number().min(40).max(240),
  musicVolume: z.number().min(0).max(1), sfx: z.boolean(),
});
let analyzing = false;
app.post('/api/plan', async (req, res) => {
  const payload = z.object({assetIds: z.array(z.string()).min(1).max(12), musicId: z.string().optional(), settings: settingsSchema}).parse(req.body);
  if (analyzing) return res.status(429).json({error: 'Analisis sedang berjalan. Coba lagi sebentar.'});
  const assets = [...new Set(payload.assetIds)].map(id => records.get(id)?.asset);
  if (assets.some(asset => asset?.kind !== 'video')) return res.status(400).json({error: 'Pilih B-roll video yang tersedia.'});
  const music = payload.musicId ? records.get(payload.musicId) : undefined;
  if (payload.musicId && (!music || music.asset.kind !== 'audio')) return res.status(400).json({error: 'Musik tidak ditemukan.'});
  analyzing = true;
  try {
    const duration = Math.min(payload.settings.duration, music?.asset.duration ?? payload.settings.duration);
    if (duration < 6) return res.status(400).json({error: 'Musik harus berdurasi minimal 6 detik.'});
    const analysis = music ? await analyzeAudio(path.join(mediaDir, music.file), duration, payload.settings.bpm) : gridAnalysis(duration, payload.settings.bpm);
    const plan = makePlan(assets as MediaAsset[], music?.asset, payload.settings, analysis);
    if (payload.settings.sfx) plan.sfxUrl = `/media/${path.basename(await ensureSfx(mediaDir))}`;
    plans.set(plan.id, plan);
    if (plans.size > 200) plans.delete(plans.keys().next().value!);
    res.json({plan});
  } finally {analyzing = false;}
});

app.post('/api/render', async (req, res) => {
  const {planId} = z.object({planId: z.string()}).parse(req.body);
  const plan = plans.get(planId);
  if (!plan) return res.status(404).json({error: 'Susun ulang edit sebelum mengekspor (rencana tidak ditemukan).'});
  if (controllers.size) return res.status(409).json({error: 'Satu ekspor sedang berjalan. Tunggu atau batalkan terlebih dahulu.'});
  const job: RenderJob = {id: randomUUID(), status: 'queued', progress: 0};
  jobs.set(job.id, job);
  const controller = new AbortController();
  controllers.set(job.id, controller);
  const output = path.join(exportDir, `${job.id}.mp4`);
  const origin = `http://127.0.0.1:${port}`;
  res.status(202).json({job});
  job.status = 'rendering';
  void renderPlan(plan, output, origin, progress => {job.progress = Math.max(job.progress, Math.min(0.99, progress));}, controller.signal)
    .then(() => {
      if (controller.signal.aborted) {job.status = 'cancelled'; return unlink(output).catch(() => {});}
      job.status = 'done'; job.progress = 1; job.url = `/exports/${job.id}.mp4`;
    })
    .catch(async error => {
      job.status = controller.signal.aborted ? 'cancelled' : 'error';
      if (job.status === 'error') {job.error = error instanceof Error ? error.message : 'Ekspor gagal.'; console.error('Render gagal:', error);}
      await unlink(output).catch(() => {});
    })
    .finally(() => controllers.delete(job.id));
});
app.get('/api/render/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({error: 'Ekspor tidak ditemukan.'});
  res.json({job});
});
app.delete('/api/render/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({error: 'Ekspor tidak ditemukan.'});
  controllers.get(job.id)?.abort();
  if (job.status === 'queued' || job.status === 'rendering') job.status = 'cancelled';
  res.json({job});
});
app.use('/api', (_req, res) => res.status(404).json({error: 'Endpoint tidak ditemukan.'}));
let closeDevServer: (() => Promise<void>) | undefined;
if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(root, 'dist')));
  app.get('/{*path}', (_req, res) => res.sendFile(path.join(root, 'dist', 'index.html')));
} else {
  const {createServer} = await import('vite');
  const vite = await createServer({root, server: {middlewareMode: true}, appType: 'spa'});
  app.use(vite.middlewares);
  closeDevServer = () => vite.close();
}
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (error instanceof z.ZodError) return res.status(400).json({error: 'Pengaturan tidak valid.', details: error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`)});
  if (error instanceof multer.MulterError) return res.status(400).json({error: 'Unggahan dibatasi 12 berkas, maksimal 250 MB per berkas.'});
  console.error(error);
  res.status(400).json({error: error instanceof Error ? error.message : 'Media tidak dapat diproses.'});
});
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const server = app.listen(port, host, () => console.log(`Forma listening on ${host}:${port}`));
function shutdown() {
  for (const controller of controllers.values()) controller.abort();
  server.close();
  void closeDevServer?.();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
