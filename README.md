# Local Copilot

Copilot-style coding assistance for VS Code that runs **entirely on your machine** with Ollama
(or LM Studio / llama.cpp). No cloud, no account, no telemetry: the extension only ever talks to `127.0.0.1`.

- **Ghost-text completion** while you type (fill-in-the-middle, Tab to accept), ~400 ms on an 8 GB laptop GPU.
- **Comment → code**: write `// Create a function that validates a French SIRET number`, press Enter, the code appears.
- **Code intelligence** on demand: explain, review, **security review** (static rules + AI verification),
  generate tests, refactor and fix (always as a diff you approve), write doc comments.
- **Directive comments**: `# Review the function below for security issues` gets a clickable CodeLens.
- **`@codebase` questions** over a local index of your repository (symbols, import graph, keyword and
  semantic search), with clickable `file:line` citations.
- **Dashboard**: privacy status, models per role with one-click install, VRAM usage, index, latency metrics.

## Install

1. Install [Ollama](https://ollama.com), then pull the default models:
   ```bash
   ollama pull qwen2.5-coder:3b-base
   ollama pull qwen3.5:9b
   ollama pull qwen3-embedding:0.6b
   ```
2. Download `local-copilot-<version>.vsix` from the [latest release](https://github.com/Miche1-Pierre/local-copilot/releases/latest)
   and install it: `code --install-extension local-copilot-<version>.vsix`
   (or *Extensions → … → Install from VSIX*).
3. Open a project. The status bar shows `✨ qwen2.5-coder:3b-base`. The first completion after Ollama starts
   loads the model (a few seconds); after that it is fast.

The dashboard (*Local Copilot: Open Dashboard*) detects your GPU and recommends smaller or larger models.
If another completion extension is active (e.g. GitHub Copilot), disable its inline suggestions, otherwise
both compete for the ghost text.

## Using it

| Do | How |
|---|---|
| Accept ghost text | `Tab` (word by word: `Ctrl+→`), dismiss with `Esc`, ask explicitly with `Alt+\` |
| All actions | `Ctrl+Alt+L`, then one letter: **E** explain · **V** review · **S** security · **T** tests · **R** refactor · **F** fix · **D** docs · **G** generate · **A** ask the codebase |
| Generate from a comment | cursor on the comment or the empty line below, `Ctrl+Alt+Enter` (uses the larger model; Tab to accept) |
| Ask the codebase | `Ctrl+Alt+K`, or the box at the bottom of the results panel |
| Right-click | *Local Copilot* submenu in the editor |
| Fix a problem | lightbulb on any error: *Local Copilot: explain and fix*; on a finding: *fix this finding* |
| Status / quick settings | click the status bar item (toggle, snooze, models, dashboard, logs) |

Commands act on the selection, else on the function/class around the cursor. Refactors, fixes and
doc comments open as a **diff**: nothing changes in your file until you click *Apply*.

Directive comments understood (English and French): *review*, *security / vulnerabilities / sécurité*,
*explain / explique*, *write tests / écris des tests*, *refactor / simplify*, *document / add docstring*,
*fix / corrige*, and implementation instructions (*create, implement, write, add… / crée, implémente…*).

## Default models

Benchmarked on an RTX 5070 Laptop GPU (8 GB) against a real ~300-script Unity C# project
([details](docs/MODELS.md)):

| Role | Model | Measured |
|---|---|---|
| Completion | `qwen2.5-coder:3b-base` | p50 392 ms per line, same line accuracy as the 7B at half the latency |
| Intelligence | `qwen3.5:9b` | ~26 tok/s while sharing an 8 GB GPU with the completion model (no model swaps), reviews in ~10 s |
| Embeddings | `qwen3-embedding:0.6b` | ~27 chunks/s; a 550-file repository is embedded once in ~4 min, in the background |

Change models from the dashboard or with *Local Copilot: Select … Model*. Per-task overrides:
`localCopilot.chat.taskModels` (e.g. `{ "security": "qwen3:14b" }`).

## Privacy

Loopback-only endpoints (checked before every request, DNS included), redirects refused, cloud models
refused, no telemetry, strict webview CSP, index stored outside your repository. Run
**Local Copilot: Verify Local-Only Setup** for a live report. What a network can and cannot see, and how
to harden Ollama itself (bind address, `OLLAMA_NO_CLOUD`, optional firewall rule):
[docs/PRIVACY.md](docs/PRIVACY.md).

## Main settings

| Setting | Default | |
|---|---|---|
| `localCopilot.provider` / `endpoint` | `ollama` / `http://127.0.0.1:11434` | also `lmstudio`, `llamacpp`, `openai-compatible`; per-role overrides |
| `localCopilot.autocomplete.model` | `qwen2.5-coder:3b-base` | use a *base* code model |
| `localCopilot.autocomplete.debounceMs` | `120` | |
| `localCopilot.autocomplete.multiline` | `auto` | `always` / `never` |
| `localCopilot.autocomplete.disabledLanguages` | plaintext, markdown… | |
| `localCopilot.chat.model` | `qwen3.5:9b` | |
| `localCopilot.chat.gpuLayers` | `-1` (auto) | caps the intelligence model on small GPUs so both models stay loaded |
| `localCopilot.chat.reasoning` | `off` | `deep` (security/review/fix/codebase) or `always` |
| `localCopilot.chat.language` | `auto` | language of explanations |
| `localCopilot.embeddings.enabled` | `true` | background, paused while you type |
| `localCopilot.security.scanOnSave` | `false` | static rules on every save |

## Development

```bash
npm install
npm run build            # esbuild → dist/
npm test                 # unit tests (vitest)
npm run test:integration # real VS Code + mock Ollama; LIVE=1 to use your local models
npm run check:egress     # shipped bundles contain no non-loopback address
npm run bench -- --dir <code folder> --ext .cs
npm run package          # dist/local-copilot.vsix
```

Branches: work happens on `dev`; `main` only receives releases. `npm run release -- patch` (or `minor`,
`major`, `X.Y.Z`) runs the checks, bumps the version, moves the *Unreleased* changelog entries under the new
version, builds the `.vsix`, merges `dev` into `main`, tags, pushes and publishes the GitHub release.
Add `--dry-run` to see the plan first.

Architecture: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

[MIT](LICENSE)
