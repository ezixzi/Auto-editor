export type Theme = 'black' | 'white';
export type Aspect = '16:9' | '9:16' | '1:1';
export interface MediaAsset {
  id: string;
  name: string;
  kind: 'video' | 'audio';
  url: string;
  duration: number;
  width?: number;
  height?: number;
  thumbnail?: string;
  score?: number;
}
export interface EditorSettings {
  title: string;
  subtitle: string;
  theme: Theme;
  aspect: Aspect;
  duration: number;
  bpm: number;
  musicVolume: number;
  sfx: boolean;
}
export interface BeatAnalysis {
  beats: number[];
  waveform: number[];
  bpm: number;
  confidence: number;
  source: 'detected' | 'grid';
}
export interface Scene {
  id: string;
  kind: 'title' | 'clip' | 'reveal' | 'outro';
  from: number;
  duration: number;
  assetId?: string;
  src?: string;
  sourceStart: number;
  sourceDuration?: number;
  playbackRate: number;
  label: string;
  headline?: string;
  subtitle?: string;
}
export interface EditPlan {
  id: string;
  fps: number;
  width: number;
  height: number;
  durationInFrames: number;
  settings: EditorSettings;
  analysis: BeatAnalysis;
  scenes: Scene[];
  musicUrl?: string;
  sfxUrl?: string;
  revealFrame: number;
  warnings: string[];
}
export interface RenderJob {
  id: string;
  status: 'queued' | 'rendering' | 'done' | 'error' | 'cancelled';
  progress: number;
  url?: string;
  error?: string;
}
export const DEFAULT_SETTINGS: EditorSettings = {
  title: 'Less. But better.', subtitle: 'Every detail matters.',
  theme: 'black', aspect: '16:9', duration: 16, bpm: 120, musicVolume: 0.7, sfx: true,
};
