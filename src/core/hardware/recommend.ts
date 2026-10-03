// Model recommendations from the machine's memory. The 6-10 GB tier was
// benchmarked on an RTX 5070 Laptop (8 GB): qwen2.5-coder 3b-base completes a
// line in ~390 ms p50 with the same accuracy as the 7b (~700 ms), and
// qwen3.5:9b generates ~42 tok/s with 16k context.

export interface GpuInfo {
  name: string;
  vramMB: number;
  vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'other';
}

export interface HardwareProfile {
  gpus: GpuInfo[];
  totalRamMB: number;
  cpuModel?: string;
  cpuThreads?: number;
  platform: string;
  appleSilicon?: boolean;
}

export interface ModelPick {
  model: string;
  sizeGB: number;
  reason: string;
}

export interface Recommendation {
  tier: string;
  usableVramGB: number;
  autocomplete: ModelPick;
  chat: ModelPick;
  embeddings: ModelPick;
  chatContextLength: number;
  notes: string[];
}

const EMBEDDINGS: ModelPick = { model: 'qwen3-embedding:0.6b', sizeGB: 0.6, reason: 'Small, strong on code retrieval, 1024-dim vectors.' };

/** Discrete VRAM, or the share of unified memory a GPU can use on Apple Silicon. */
export function usableVramGB(hw: HardwareProfile): number {
  if (hw.appleSilicon) return Math.round((hw.totalRamMB * 0.65) / 102.4) / 10;
  const discrete = hw.gpus.filter((g) => g.vendor === 'nvidia' || g.vendor === 'amd');
  const best = Math.max(0, ...discrete.map((g) => g.vramMB));
  return Math.round(best / 102.4) / 10;
}

export function recommendModels(hw: HardwareProfile): Recommendation {
  const vram = usableVramGB(hw);
  const ramGB = hw.totalRamMB / 1024;
  const notes: string[] = [];
  let tier: string;
  let autocomplete: ModelPick;
  let chat: ModelPick;
  let ctx: number;

  if (vram < 6) {
    tier = vram < 4 ? 'CPU or < 4 GB GPU' : '4-6 GB GPU';
    autocomplete = { model: 'qwen2.5-coder:1.5b-base', sizeGB: 1.0, reason: 'Tiny FIM model: usable latency even on CPU.' };
    chat = { model: 'qwen3.5:4b', sizeGB: 3.4, reason: 'Best quality that stays responsive in this memory budget.' };
    ctx = 8192;
    if (vram < 4) notes.push('Without a capable GPU everything runs on the CPU: expect ~1 s completions and slow analyses.');
  } else if (vram < 10) {
    tier = '6-10 GB GPU';
    autocomplete = { model: 'qwen2.5-coder:3b-base', sizeGB: 1.9, reason: 'Measured on an 8 GB laptop GPU: ~390 ms per line, as accurate as the 7B, twice as fast.' };
    chat = { model: 'qwen3.5:9b', sizeGB: 6.6, reason: 'Newest generation that fits a mid-range GPU; ~40 tok/s with a 16k context.' };
    ctx = 16384;
  } else if (vram < 16) {
    tier = '10-16 GB GPU';
    autocomplete = { model: 'qwen2.5-coder:7b-base', sizeGB: 4.7, reason: 'Stronger multi-line completions; still well under a second.' };
    chat = { model: 'qwen3.5:9b', sizeGB: 6.6, reason: 'Fits next to the completion model, so neither has to be reloaded.' };
    ctx = 32768;
  } else if (vram < 24) {
    tier = '16-24 GB GPU';
    autocomplete = { model: 'qwen2.5-coder:7b-base', sizeGB: 4.7, reason: 'Best speed/quality balance for fill-in-the-middle.' };
    chat =
      ramGB >= 32
        ? { model: 'qwen3.6:35b-a3b', sizeGB: 24, reason: 'Mixture-of-experts with 3B active parameters: frontier-level coding, fast even partly on CPU.' }
        : { model: 'qwen3.5:9b', sizeGB: 6.6, reason: 'Keeps everything on the GPU.' };
    ctx = 32768;
  } else {
    tier = '24 GB+ GPU';
    autocomplete = { model: 'qwen2.5-coder:7b-base', sizeGB: 4.7, reason: 'Fast FIM leaves the GPU to the large model.' };
    chat = { model: 'qwen3.6:27b', sizeGB: 17, reason: 'Strongest local coding model of its size (agentic coding, long context).' };
    ctx = 32768;
  }

  if (vram > 0 && autocomplete.sizeGB + chat.sizeGB > vram * 0.9) {
    notes.push(
      `The completion and intelligence models (${(autocomplete.sizeGB + chat.sizeGB).toFixed(1)} GB) do not fit together at full GPU offload in ${vram} GB of VRAM: ` +
        'Local Copilot caps the intelligence model\'s GPU layers so both stay loaded (no model swaps; setting localCopilot.chat.gpuLayers).',
    );
  }
  if (ramGB < 16) notes.push('With less than 16 GB of RAM, close heavy applications before running analyses.');
  return { tier, usableVramGB: vram, autocomplete, chat, embeddings: EMBEDDINGS, chatContextLength: ctx, notes };
}

export function describeHardware(hw: HardwareProfile): string {
  const gpu = hw.gpus
    .filter((g) => g.vendor !== 'intel' || hw.gpus.length === 1)
    .map((g) => `${g.name} (${(g.vramMB / 1024).toFixed(1)} GB)`)
    .join(', ');
  const ram = `${Math.round(hw.totalRamMB / 1024)} GB RAM`;
  return [gpu || 'no dedicated GPU detected', ram, hw.cpuModel].filter(Boolean).join(' · ');
}
