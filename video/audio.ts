import type { EditPlan } from '../shared/types';

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => {
  const t = clamp(value);
  return t * t * (3 - 2 * t);
};

/** One shared envelope keeps the player and encoded audio in sync. */
export function getMusicVolume(plan: EditPlan, frame: number): number {
  const { fps, revealFrame, durationInFrames } = plan;
  const fadeIn = smooth(frame / (fps * 0.35));
  const fadeOut = smooth((durationInFrames - 1 - frame) / (fps * 0.8));
  const silenceStart = revealFrame - Math.round(fps * 0.25);
  const dipStart = revealFrame - Math.round(fps * 0.5);
  let revealGain = 1;
  if (frame >= dipStart && frame < silenceStart) {
    revealGain = 1 - smooth((frame - dipStart) / (silenceStart - dipStart));
  } else if (frame >= silenceStart && frame < revealFrame) {
    revealGain = 0;
  } else if (frame >= revealFrame && frame < revealFrame + fps * 0.15) {
    revealGain = smooth((frame - revealFrame) / (fps * 0.15));
  }
  return clamp(plan.settings.musicVolume) * fadeIn * fadeOut * revealGain;
}
