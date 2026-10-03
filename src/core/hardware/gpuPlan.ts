// GPU layer planning: on a small GPU, cap the intelligence model's GPU layers so
// the completion model stays resident. Measured on an 8 GB RTX 5070 Laptop with
// qwen3.5:9b + qwen2.5-coder:3b-base: Ollama otherwise evicts one model each time
// (7 s to reload the 9B, 3.5 s for the 3B); capped at ~26/32 layers both stay
// loaded, completions keep their ~170 ms and the 9B still streams ~26 tok/s.

export interface GpuPlanInput {
  /** Total VRAM of the GPU, MB. */
  totalMB: number;
  /** VRAM currently used on the GPU, MB (all processes). */
  usedMB: number;
  /** VRAM currently used by models the inference server has loaded, MB. */
  serverLoadedMB: number;
  /** VRAM the completion model needs (loaded size if loaded, else file size), MB. */
  completionMB: number;
  /** VRAM to keep for the embedding model (0 when embeddings are off), MB. */
  embeddingMB: number;
  /** File size of the intelligence model, MB. */
  chatModelMB: number;
  /** Transformer blocks of the intelligence model. */
  blocks: number;
}

/** Compute buffers, CUDA context and a safety margin. */
const RESERVE_MB = 600;
/** Share of a model file that lives in its repeating blocks (embeddings, vision tower, output stay off the estimate). */
const LAYER_SHARE = 0.8;

/** Undefined = no cap needed (everything fits); otherwise the number of layers to offload. */
export function planChatGpuLayers(p: GpuPlanInput): number | undefined {
  const otherApps = Math.max(0, p.usedMB - p.serverLoadedMB);
  const available = p.totalMB - otherApps - p.completionMB - p.embeddingMB - RESERVE_MB;
  if (available >= p.chatModelMB) return undefined;
  if (available <= 0 || p.blocks <= 0) return 0;
  return Math.max(0, Math.min(p.blocks, Math.floor((p.blocks * available) / (p.chatModelMB * LAYER_SHARE))));
}
