# Architecture

Local Copilot is a VS Code extension that talks to a **local** inference server
(Ollama by default). There is no backend, no Python service, no Docker: the
extension host is the only process we ship.

```text
VS Code ──► extension (TypeScript) ──► LocalHttpClient ──► 127.0.0.1:11434 (Ollama) ──► local models
              │                          ▲
              │                          └─ every URL re-checked: loopback only, no redirects
              ├─ Inline Completion Engine ──── fast FIM model (qwen2.5-coder:3b-base)
              ├─ Code Intelligence ─────────── instruct model (qwen3.5:9b)
              └─ Codebase Index ────────────── symbols + imports graph + BM25 + embeddings (qwen3-embedding:0.6b)
```

## Two engines, two latency budgets

| | Inline completion | Code intelligence |
|---|---|---|
| Trigger | every pause in typing (debounced) | explicit command, CodeLens, quick fix |
| Model | small **base** code model, fill-in-the-middle | instruct / reasoning model |
| Budget | < 500 ms (measured p50 ≈ 390 ms on an 8 GB laptop GPU) | seconds, streamed |
| Context | ~3k tokens, stable between keystrokes (KV-cache reuse) | up to the model window (16k by default) |
| Output | ghost text | results panel, diagnostics, diff proposals, ghost text |

## Source layout

```text
src/
  core/                      pure TypeScript, no `vscode` import → unit-tested with vitest
    policy/localOnly.ts      loopback checks, DNS verification, cloud-model refusal, Ollama exposure audit
    providers/               ModelProvider interface + Ollama, OpenAI-compatible (LM Studio, vLLM), llama.cpp
      http.ts                the ONLY network entry point (policy check, redirect: error, timeouts, NDJSON/SSE)
    fim/                     FIM templates per model family, trigger/mode heuristics, post-processing
    completion/              engine (debounce, single flight, early stop, metrics) + type-ahead cache
    context/similarity.ts    "neighbouring tabs" Jaccard windows
    index/                   lexer (masks strings/comments), symbols, imports, chunker, BM25, vectors, .gitignore,
                             codebase index (symbol table, reference graph, hybrid search), project summary
    intelligence/            prompts, JSON schemas, tolerant parsing, comment directives
    security/                static rules, intra-function taint heuristic, analyzer
    hardware/recommend.ts    model tiers from VRAM/RAM
    metrics/metrics.ts       local-only latency / acceptance metrics
  vscode/                    adapters: inline provider, model manager, indexer, context gatherer,
                             intelligence service, panel + dashboard hosts, proposals (diff), findings
                             (diagnostics + quick fixes), status bar, menus, CodeLens
  webview/                   browser side of the panel and dashboard + their message protocol
  extension.ts               composition root
```

## Provider abstraction

`ModelProvider` exposes `fim`, `chat`, `embed`, `listModels`, `loadedModels`,
`warmup`, `pull`. Implementations:

- **Ollama** — `/api/generate` with `raw: true` and our own FIM template (repository
  tokens included), or `suffix` in "native" mode; `/api/chat` with `think` and `format`
  (JSON schema); `/api/embed`; `/api/tags` (capabilities, remote flag), `/api/ps`, `/api/pull`.
- **OpenAI-compatible** (LM Studio, vLLM, LocalAI) — `/v1/completions` for FIM, `/v1/chat/completions`
  with `response_format: json_schema`, `/v1/embeddings`; LM Studio's `/api/v0/models` for model types.
- **llama.cpp** — native `/infill` (server applies the model's FIM tokens and takes `input_extra`
  repository context), falling back to `/v1/completions`.

Each role (completion, intelligence, embeddings) can use a different server, e.g. llama.cpp for
completion and Ollama for the rest.

## Inline completion pipeline

1. `shouldTrigger` — never in the middle of real code (only closing punctuation may follow the cursor).
2. Type-ahead cache — typing the start of the current suggestion serves the rest instantly.
3. Debounce (120 ms), then single flight: a new request aborts the previous one (the server stops
   generating when the connection closes).
4. Prompt: prefix (≈1600 tokens) + suffix (≈400) + repository context (≈1000): definitions of the
   symbols near the cursor (from the index), the most similar window of recently used editors,
   outlines of imported files. Context is cached per 15-line region for 20 s so the prompt prefix
   stays identical while you type and the server reuses its KV cache.
5. Streaming with early stop: single line → stop at the newline; block → stop as soon as a
   completed line leaves the current block (indentation / closing bracket).
6. Post-processing: special tokens, block end, duplicated closing brackets, regurgitated suffix,
   repetition, overlap with the punctuation after the cursor (`foo(|)` → replace to end of line).

## Code intelligence pipeline

Target = selection, else the directive comment's block, else the enclosing function/class (language
server symbols when available, our scanner otherwise). Context = definitions the code uses + related
files (imports and reference graph) + project summary (frameworks, test framework). Answers stream into
the results panel; edits are **always** proposed as a diff (`local-copilot-proposal:` documents) and
applied only on *Apply*.

Security review = static rules (≈40, CWE-tagged) → intra-function taint (parameters / request input
reaching a sink raise confidence) → the model confirms or rejects each static finding and adds what
the rules missed (JSON schema) → merged findings as diagnostics with quick fixes.

## Codebase index

Stored in VS Code's workspace storage (never in your repository). Per file: symbols (brace,
indentation and `end` based scanners on comment/string-masked text), imports (resolved for TS/JS,
Python, C/C++, Rust, Go, Java/Kotlin, C# via declared namespaces), chunks aligned on functions and
Markdown sections. Global: symbol table, reference graph (types/functions a file uses → files defining
them; names defined in more than 3 files are ignored, so Unity's `Start`/`Update` do not link
everything), BM25 over chunks, embeddings (background, paused while typing or during analyses,
persisted). Search = reciprocal-rank fusion of exact symbol hits, BM25 and vectors.

Measured on a 554-file Unity repository: full index in 1.2 s; embeddings of 7151 chunks in 4.4 min
once (then incremental); hybrid query < 60 ms including the query embedding.

## Extending

- New server: implement `ModelProvider`, add it to `ProviderRegistry`.
- New FIM family: add a template in `core/fim/templates.ts` and a name pattern in `detectFimTemplate`.
- New language for symbols: add a matcher in `core/index/symbols.ts` (and a lexer config in `scanner.ts`).
- New security rule: add an entry to `core/security/rules.ts` with a positive and a negative test.
