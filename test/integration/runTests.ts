// Launches VS Code with the extension under development against the fixture
// workspace. Default: a mock Ollama server. LIVE=1: the real local Ollama.
// Uses the installed VS Code when found (isolated profile), else downloads one.

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runTests } from '@vscode/test-electron';
import { startMockOllama, type MockOllama } from './mockOllama';

function installedCode(): string | undefined {
  const candidates = [
    process.env.VSCODE_EXECUTABLE,
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe') : undefined,
    '/Applications/Visual Studio Code.app/Contents/MacOS/Electron',
    '/usr/share/code/code',
  ];
  return candidates.find((c) => c && existsSync(c));
}

async function main(): Promise<void> {
  const live = process.env.LIVE === '1';
  const root = resolve(__dirname, '..', '..', '..');
  let mock: MockOllama | undefined;
  let endpoint = 'http://127.0.0.1:11434';
  if (!live) {
    mock = await startMockOllama();
    endpoint = mock.url;
  }
  const profile = mkdtempSync(join(tmpdir(), 'local-copilot-test-'));
  const userDir = join(profile, 'user-data', 'User');
  mkdirSync(userDir, { recursive: true });
  writeFileSync(
    join(userDir, 'settings.json'),
    JSON.stringify(
      {
        'localCopilot.endpoint': endpoint,
        'localCopilot.autocomplete.debounceMs': 0,
        'localCopilot.chat.language': 'English',
        'security.workspace.trust.enabled': false,
        'workbench.startupEditor': 'none',
        'telemetry.telemetryLevel': 'off',
        'update.mode': 'none',
        'extensions.autoUpdate': false,
      },
      null,
      2,
    ),
  );
  try {
    await runTests({
      vscodeExecutablePath: installedCode(),
      extensionDevelopmentPath: root,
      extensionTestsPath: join(__dirname, 'suite', 'index.js'),
      launchArgs: [
        join(root, 'test', 'fixtures', 'workspace'),
        '--disable-extensions',
        `--user-data-dir=${join(profile, 'user-data')}`,
        `--extensions-dir=${join(profile, 'extensions')}`,
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-workspace-trust',
      ],
      extensionTestsEnv: { LOCAL_COPILOT_LIVE: live ? '1' : '0' },
    });
  } finally {
    await mock?.close();
    rmSync(profile, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
