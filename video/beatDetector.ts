export type BeatAudioData = { sampleRate: number } & (
  | { channelData: readonly Float32Array[] }
  | { channelWaveforms: readonly Float32Array[] }
  | { numberOfChannels: number; getChannelData: (index: number) => Float32Array }
);

/** Detect transient onsets; returned frames are observations, never a synthetic grid. */
export function getBeatTimestamps(audioData: BeatAudioData, fps: number): number[] {
  const { sampleRate } = audioData;
  if (!Number.isFinite(fps) || fps <= 0 || !Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new RangeError('fps and sampleRate must be finite, positive numbers.');
  }
  const channels = 'channelData' in audioData ? audioData.channelData
    : 'channelWaveforms' in audioData ? audioData.channelWaveforms
      : Array.from({ length: audioData.numberOfChannels }, (_, i) => audioData.getChannelData(i));
  const length = channels.reduce((max, channel) => Math.max(max, channel.length), 0);
  if (!length || !channels.length) return [];

  const hop = Math.max(1, Math.round(sampleRate * 0.01));
  const energy = new Float64Array(Math.ceil(length / hop));
  const powers = new Float64Array(5);
  let rollingPower = 0;
  let peakEnergy = 0;
  for (let i = 0; i < energy.length; i++) {
    const start = i * hop;
    const end = Math.min(length, start + hop);
    let squares = 0;
    for (const channel of channels) {
      for (let sample = start; sample < Math.min(end, channel.length); sample++) {
        const value = channel[sample];
        if (Number.isFinite(value)) squares += value * value;
      }
    }
    // A 50ms RMS window suppresses stationary sub-bass; summing powers preserves stereo.
    const power = squares / ((end - start) * channels.length);
    rollingPower += power - powers[i % powers.length];
    powers[i % powers.length] = power;
    energy[i] = Math.sqrt(Math.max(0, rollingPower) / Math.min(i + 1, powers.length));
    peakEnergy = Math.max(peakEnergy, energy[i]);
  }
  if (peakEnergy < 1e-5) return [];

  const onset = new Float64Array(energy.length);
  const prefix = new Float64Array(energy.length + 1);
  let peakOnset = 0;
  for (let i = 0; i < energy.length; i++) {
    let baseline = 0;
    const count = Math.min(i, 6);
    for (let offset = 1; offset <= count; offset++) baseline += energy[i - offset];
    onset[i] = Math.max(0, energy[i] - (count ? baseline / count : 0));
    prefix[i + 1] = prefix[i] + onset[i];
    peakOnset = Math.max(peakOnset, onset[i]);
  }

  const candidates: { frame: number; strength: number }[] = [];
  const minGap = Math.max(1, Math.round(fps * 0.2));
  for (let i = 0; i < onset.length; i++) {
    const left = Math.max(0, i - 15);
    const right = Math.min(onset.length, i + 16);
    const neighbours = right - left - 1;
    const average = neighbours ? (prefix[right] - prefix[left] - onset[i]) / neighbours : 0;
    const threshold = Math.max(peakOnset * 0.05, average * 1.6, energy[i] * 0.12);
    if (energy[i] < peakEnergy * 0.01 || onset[i] <= threshold
      || onset[i] < (onset[i - 1] ?? 0) || onset[i] <= (onset[i + 1] ?? 0)) continue;
    const frame = Math.min(Math.floor((length - 1) / sampleRate * fps), Math.round(i * hop / sampleRate * fps));
    const previous = candidates[candidates.length - 1];
    if (previous && frame - previous.frame < minGap) {
      if (onset[i] > previous.strength) candidates[candidates.length - 1] = { frame, strength: onset[i] };
    } else candidates.push({ frame, strength: onset[i] });
  }
  return candidates.map(({ frame }) => frame);
}
