# Changelog

All notable changes. `npm run release` moves the *Unreleased* entries under the new version.

## Unreleased

## 0.1.0 — 2026-10-03

First version.

- Inline fill-in-the-middle completion with repository context, type-ahead cache, single-flight requests,
  streaming early stop and block-aware post-processing.
- Code intelligence: explain, review, security review (static rules + taint heuristic + AI verdicts),
  tests, refactor / fix / documentation as diff proposals, generate from comment, `@codebase` questions,
  follow-ups.
- Directive comments with CodeLens (English and French).
- Local codebase index: symbols, import and reference graph, BM25, background embeddings.
- Providers: Ollama, LM Studio, llama.cpp, any OpenAI-compatible local server; per-role servers and models.
- Local-only policy (loopback endpoints with DNS check, no redirects, no cloud models), no telemetry.
- Dashboard: privacy audit, models per role, hardware-based recommendations with install, VRAM, index, metrics.
