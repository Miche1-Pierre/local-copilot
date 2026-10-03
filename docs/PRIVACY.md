# Privacy and the local-only guarantee

**No file, prompt, code excerpt or model output leaves your machine because of this extension.**

## What the extension enforces

| Guarantee | How |
|---|---|
| Only loopback servers | Endpoints must be `127.0.0.0/8`, `::1` or `localhost` (checked when settings load **and** before every request in `LocalHttpClient`). Names are resolved and must only map to loopback addresses (a tampered hosts file is caught). |
| No redirects | Requests use `redirect: 'error'`: a local server cannot bounce a request elsewhere. |
| No cloud models | Ollama `:cloud` / `-cloud` models and anything the server reports as remote (`remote_host`) are refused, hidden from the pickers and flagged in the dashboard. |
| No telemetry | No analytics, crash reporting, remote logging or `TelemetryLogger`. Metrics stay in VS Code's local storage and can be cleared. |
| No remote assets | Webviews use a strict CSP (`default-src 'none'`, scripts by nonce); no CDN, font or image is fetched. Links in model answers are rendered as plain text. |
| Verifiable | `npm test` includes a test that fails if any source contains a non-loopback address or uses `fetch` outside the policy-checked client; `npm run check:egress` scans the shipped bundles. **Local Copilot: Verify Local-Only Setup** prints a live report. |
| Settings scope | Server endpoints are machine-scoped: a repository's `.vscode/settings.json` cannot redirect them. |

Workspace data (index, embeddings) lives in VS Code's per-workspace storage folder, not in your repo.

## What a network (your Wi-Fi) can see

- **Nothing of your work.** Completions and analyses travel between VS Code and Ollama over the loopback
  interface (`127.0.0.1`), inside the operating system: they never reach the Wi-Fi card, the router or the
  internet. No prompt, code or answer can be observed on the network, whichever Wi-Fi you are on.
- **Only Ollama's own internet traffic**, which this extension does not cause except when you click
  *Install* in the dashboard: model downloads and the Ollama app's update checks go to `ollama.com` over
  HTTPS. The network sees the domain names (DNS / TLS), not the content: it can tell that Ollama is
  installed, not what you do with it.
- **The Ollama port, if Ollama listens beyond loopback** (`OLLAMA_HOST=0.0.0.0`): then devices on the same
  network can find port 11434 open and use the server. On a public Wi-Fi, keep Ollama on `127.0.0.1`.

## What the extension cannot enforce: the server

The extension only ever talks to the local server. What **Ollama itself** does is configured on Ollama:

- **Bind address.** By default Ollama listens on `127.0.0.1`. With `OLLAMA_HOST=0.0.0.0:11434` (a common
  tweak to reach Ollama from Docker or another device) it listens on every interface, IPv6 included: anyone
  on your local network, and on the internet if your router does not filter inbound IPv6 (many home
  routers don't by default), can use your Ollama server. Unless you need that, set it back to
  `127.0.0.1:11434`, or keep the firewall rule for `ollama.exe` limited to the networks you trust.
- **Cloud features.** Recent Ollama versions can run "cloud" models and web search through ollama.com.
  Disable them with `OLLAMA_NO_CLOUD=1` or `"disable_ollama_cloud": true` in `~/.ollama/server.json`.
- **Downloads.** `ollama pull` (and the dashboard's *Install* button, which asks Ollama to pull) contacts
  Ollama's registry: that is the only time anything goes to the internet, and it is the model download
  itself, not your code.
- **Strictest mode.** `scripts/ollama-local-only.ps1 -BlockNet` adds a Windows Firewall rule that blocks
  all outbound traffic of `ollama.exe` (run `-UnblockNet` to download a model again).

```powershell
# from the repository folder, in your own terminal
powershell -ExecutionPolicy Bypass -File scripts\ollama-local-only.ps1 -Status
powershell -ExecutionPolicy Bypass -File scripts\ollama-local-only.ps1 -Apply        # 127.0.0.1 + OLLAMA_NO_CLOUD=1
powershell -ExecutionPolicy Bypass -File scripts\ollama-local-only.ps1 -BlockNet     # elevated prompt
```

VS Code's own telemetry is separate from this extension (`telemetry.telemetryLevel`).
