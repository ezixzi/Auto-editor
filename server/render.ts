import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { makeCancelSignal, openBrowser, renderMedia, selectComposition } from '@remotion/renderer';
import type { EditPlan } from '../shared/types';

let bundlePromise: Promise<string> | undefined;
const bundleListeners = new Set<(progress: number) => void>();

function getBundle(): Promise<string> {
  if (!bundlePromise) {
    bundlePromise = bundle({
      entryPoint: fileURLToPath(new URL('../video/index.ts', import.meta.url)),
      rootDir: fileURLToPath(new URL('../', import.meta.url)),
      onProgress: (progress) => bundleListeners.forEach((listener) => listener(progress / 100)),
    }).catch((error: unknown) => {
      bundlePromise = undefined;
      throw error;
    });
  }
  return bundlePromise;
}

/** Uploaded assets are the only network inputs accepted by the render worker. */
export function resolveRenderAssets(plan: EditPlan, origin: string): EditPlan {
  const base = new URL(origin);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    throw new Error('Invalid renderer origin.');
  }
  const resolveAsset = (src: string | undefined): string | undefined => {
    if (!src) return undefined;
    const url = new URL(src, base);
    if (url.origin !== base.origin || !url.pathname.startsWith('/media/') || url.username || url.password) {
      throw new Error('Only uploaded local media may be rendered.');
    }
    return url.href;
  };
  return {
    ...plan,
    scenes: plan.scenes.map((scene) => ({ ...scene, src: resolveAsset(scene.src) })),
    musicUrl: resolveAsset(plan.musicUrl),
    sfxUrl: resolveAsset(plan.sfxUrl),
  };
}

const checkAbort = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw new Error('Render cancelled.');
};

async function waitForBundle(signal?: AbortSignal): Promise<string> {
  if (!signal) return getBundle();
  checkAbort(signal);
  let abort: () => void = () => undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error('Render cancelled.'));
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    // Bundling is shared and cannot be aborted. A cancelled job stops waiting;
    // a future job may reuse the completed, cached bundle.
    return await Promise.race([getBundle(), cancelled]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export async function renderPlan(
  plan: EditPlan,
  outputPath: string,
  origin: string,
  onProgress: (progress: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  checkAbort(signal);
  if (plan.fps !== 30) throw new Error('Exports must use 30 fps.');
  const inputProps = { plan: resolveRenderAssets(plan, origin) };
  let lastProgress = 0;
  const report = (progress: number) => {
    if (signal?.aborted) return;
    lastProgress = Math.max(lastProgress, Math.min(1, progress));
    onProgress(lastProgress);
  };
  const reportBundle = (progress: number) => report(0.02 + progress * 0.08);
  report(0.01);
  bundleListeners.add(reportBundle);
  let serveUrl: string;
  try {
    serveUrl = await waitForBundle(signal);
  } finally {
    bundleListeners.delete(reportBundle);
  }
  checkAbort(signal);
  report(0.1);
  await mkdir(dirname(outputPath), { recursive: true });
  const browserExecutable = process.env.CHROME_PATH
    || (existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
  const browser = await openBrowser('chrome', {
    browserExecutable,
    chromeMode: 'headless-shell',
    logLevel: 'error',
  });
  const { cancel, cancelSignal } = makeCancelSignal();
  let browserClosed = false;
  const closeBrowser = async () => {
    if (browserClosed) return;
    browserClosed = true;
    await browser.close({ silent: true });
  };
  const abort = () => {
    cancel();
    void closeBrowser().catch(() => undefined);
  };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    checkAbort(signal);
    const composition = await selectComposition({
      serveUrl, id: 'FormaEdit', inputProps, puppeteerInstance: browser,
      timeoutInMilliseconds: 60_000, logLevel: 'error',
    });
    checkAbort(signal);
    report(0.15);
    await renderMedia({
      composition, serveUrl, inputProps, puppeteerInstance: browser,
      outputLocation: outputPath, codec: 'h264', audioCodec: 'aac',
      pixelFormat: 'yuv420p', crf: 19, x264Preset: 'veryfast',
      concurrency: 2, offthreadVideoThreads: 2, enforceAudioTrack: true,
      cancelSignal, timeoutInMilliseconds: 60_000, logLevel: 'error',
      onProgress: ({ progress }) => report(0.15 + Math.min(1, progress) * 0.84),
    });
    checkAbort(signal);
    report(1);
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    await closeBrowser();
  }
}
