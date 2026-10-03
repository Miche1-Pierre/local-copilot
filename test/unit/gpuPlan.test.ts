import { describe, expect, it } from 'vitest';
import { planChatGpuLayers } from '../../src/core/hardware/gpuPlan';

// Numbers measured on an RTX 5070 Laptop (8 GB) with qwen2.5-coder:3b-base loaded.
const laptop = { totalMB: 8151, usedMB: 2746, serverLoadedMB: 1945, completionMB: 1945, chatModelMB: 6287, blocks: 32 };

describe('planChatGpuLayers', () => {
  it('caps the 9B so the completion model and embeddings stay loaded', () => {
    expect(planChatGpuLayers({ ...laptop, embeddingMB: 830 })).toBe(25);
  });

  it('gives more layers when embeddings are off', () => {
    expect(planChatGpuLayers({ ...laptop, embeddingMB: 0 })).toBe(30);
  });

  it('adapts to VRAM taken by other applications (e.g. the Unity editor)', () => {
    expect(planChatGpuLayers({ ...laptop, usedMB: 2746 + 1500, embeddingMB: 830 })).toBe(15);
  });

  it('does not cap when everything fits', () => {
    expect(planChatGpuLayers({ ...laptop, totalMB: 24_576, embeddingMB: 830 })).toBeUndefined();
  });

  it('falls back to CPU when nothing is left', () => {
    expect(planChatGpuLayers({ ...laptop, usedMB: 8000, serverLoadedMB: 0, embeddingMB: 0 })).toBe(0);
  });
});
