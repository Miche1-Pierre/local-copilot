# Model choice

Benchmarked on the development machine (October 2026): **RTX 5070 Laptop GPU, 8 GB VRAM**,
Intel Core 7 240H, 32 GB RAM, Ollama 0.35.1, `OLLAMA_FLASH_ATTENTION=1`, `OLLAMA_KV_CACHE_TYPE=q8_0`.

## Selected

| Role | Model | Size | Why |
|---|---|---|---|
| Inline completion (FIM) | `qwen2.5-coder:3b-base` | 1.9 GB | Same accuracy as the 7B on real code, twice as fast (below). Base models are trained for fill-in-the-middle; chat models are not. |
| Code intelligence | `qwen3.5:9b` | 6.6 GB | Newest generation that fits an 8 GB GPU; ~42 tok/s at 16k context. Replaces the older `qwen3:14b`, which needs CPU offload on this GPU. |
| Embeddings | `qwen3-embedding:0.6b` | 0.6 GB | Small and strong on code retrieval; 1024 dimensions; ~27 chunks/s. |

The Qwen3.5 / Qwen3.6 families are not trained for FIM, which is why completion stays on Qwen2.5-Coder.

## Completion benchmark (a real Unity C# game, ~300 scripts)

`node scripts/bench-models.mjs --dir <project>/Assets/Scripts --ext .cs --samples 45`
hides the end of real lines (30 tasks) and the lines after empty lines inside blocks (15 tasks), with
the same ~3k-token prompts as the extension (prefix + suffix + another file as repository context):

| Model | Task | Exact | Edit similarity | p50 | p95 | tok/s |
|---|---|---|---|---|---|---|
| qwen2.5-coder:3b-base | line | 47% | 71% | 392 ms | 597 ms | 120 |
| qwen2.5-coder:3b-base | block | 7% | 46% | 455 ms | 1856 ms | 120 |
| qwen2.5-coder:7b-base | line | 40% | 71% | 705 ms | 1109 ms | 69 |
| qwen2.5-coder:7b-base | block | 7% | 52% | 748 ms | 3354 ms | 66 |

These are cold-prompt latencies; while typing in the same place the server reuses its KV cache and
answers faster (60–150 ms measured for short completions).

## Intelligence model measurements (`qwen3.5:9b`, 16k context)

| Task | Time | Notes |
|---|---|---|
| Explain 160 lines of C# | ~6 s (after load) | 43 tok/s |
| JSON code review, thinking off | ~11 s | 3.3k-token prompt, 367 output tokens |
| JSON code review, thinking on | ~73 s | 3k thinking tokens: better recall, too slow by default |

Hence `localCopilot.chat.reasoning = off` by default, with a *Re-run with deep reasoning* button on reviews.

## VRAM on 8 GB: keep both models loaded

The 3B completion model (1.9 GB loaded) and the 9B (5.9 GB at 16k context) do not fit together at full
GPU offload. Left alone, Ollama evicts one model to load the other, measured here:

| Sequence | Cost |
|---|---|
| analysis after typing | +7.1–7.4 s (reload the 9B) |
| first completion after an analysis | +3.5 s (reload the 3B) |

With `localCopilot.chat.gpuLayers = -1` (auto, default), Local Copilot caps the 9B's GPU layers from the
VRAM that is actually free (nvidia-smi + Ollama's `/api/ps`, so an open Unity editor is accounted for),
keeping room for the completion and embedding models. Measured:

| 9B layers on GPU | 9B VRAM | 9B speed | Both resident | Completion after an analysis |
|---|---|---|---|---|
| all (swap mode) | 5.1 GB | 42 tok/s | no | 3.6 s |
| 29 / 32 | 4.4 GB | 28–30 tok/s | yes | 168 ms |
| 26 / 32 | 4.0 GB | 26 tok/s | yes | 151 ms |
| 22 / 32 | 3.5 GB | 20 tok/s | yes | 174 ms |

Auto mode picks 25 layers with embeddings on (30 with them off). An analysis then costs about the same
total time as in swap mode (no 7 s load, slower generation) and typing never stalls. Set `999` to go back
to swap mode, or a fixed number. Background embeddings also pause while you type.

## Other machines

The dashboard detects the GPU and recommends a tier (see `src/core/hardware/recommend.ts`):

| VRAM | Completion | Intelligence |
|---|---|---|
| < 6 GB / CPU | qwen2.5-coder:1.5b-base | qwen3.5:4b |
| 6–10 GB | qwen2.5-coder:3b-base | qwen3.5:9b |
| 10–16 GB | qwen2.5-coder:7b-base | qwen3.5:9b |
| 16–24 GB (≥ 32 GB RAM) | qwen2.5-coder:7b-base | qwen3.6:35b-a3b (MoE, 3B active) |
| 24 GB + | qwen2.5-coder:7b-base | qwen3.6:27b |

Re-run the benchmark on any machine to compare candidates:

```bash
node scripts/bench-models.mjs --dir path/to/your/code --ext .ts,.py --models qwen2.5-coder:1.5b-base,qwen2.5-coder:3b-base
```
