import React from 'react';
import { Composition } from 'remotion';
import { EditVideo } from './EditVideo';

export const RemotionRoot: React.FC = () => (
  <Composition
    id="FormaEdit"
    component={EditVideo}
    fps={30}
    width={1920}
    height={1080}
    durationInFrames={480}
    defaultProps={{
      plan: {
        id: 'preview', fps: 30, width: 1920, height: 1080, durationInFrames: 480,
        settings: {
          title: 'Less. But better.', subtitle: 'Every detail matters.', theme: 'black',
          aspect: '16:9', duration: 16, bpm: 120, musicVolume: 0.7, sfx: true,
        },
        analysis: { beats: [], waveform: [], bpm: 120, confidence: 0, source: 'grid' },
        scenes: [{
          id: 'title', kind: 'title', from: 0, duration: 480, sourceStart: 0,
          playbackRate: 1, label: 'Opening', headline: 'Less. But better.',
          subtitle: 'Every detail matters.',
        }],
        revealFrame: 300, warnings: [],
      },
    }}
    calculateMetadata={({ props }) => ({
      fps: props.plan.fps,
      width: props.plan.width,
      height: props.plan.height,
      durationInFrames: props.plan.durationInFrames,
      defaultCodec: 'h264',
    })}
  />
);
