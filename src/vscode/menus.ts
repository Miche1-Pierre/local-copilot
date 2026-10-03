import * as vscode from 'vscode';
import { fimSupport } from '../core/fim/templates';
import { findDirectives, type DirectiveKind } from '../core/intelligence/directives';
import { isRemoteModel } from '../core/policy/localOnly';
import type { ModelManager } from './modelManager';
import { settings, updateSetting, type RoleName } from './settings';

interface MenuEntry {
  key: string;
  label: string;
  icon: string;
  detail: string;
  command: string;
}

const ACTIONS: MenuEntry[] = [
  { key: 'E', label: 'Explain', icon: 'book', detail: 'what this code does and how', command: 'localCopilot.explain' },
  { key: 'V', label: 'Review', icon: 'checklist', detail: 'bugs, risks, performance', command: 'localCopilot.review' },
  { key: 'S', label: 'Security review', icon: 'shield', detail: 'static rules + AI verification', command: 'localCopilot.securityReview' },
  { key: 'T', label: 'Generate tests', icon: 'beaker', detail: 'with the project’s test framework', command: 'localCopilot.generateTests' },
  { key: 'R', label: 'Refactor…', icon: 'wand', detail: 'proposed as a diff', command: 'localCopilot.refactor' },
  { key: 'F', label: 'Fix / why is this failing?', icon: 'debug', detail: 'uses the diagnostics of the code', command: 'localCopilot.fix' },
  { key: 'D', label: 'Document', icon: 'note', detail: 'doc comment in the language’s style', command: 'localCopilot.document' },
  { key: 'G', label: 'Generate from comment', icon: 'sparkle', detail: 'implement the comment above the cursor', command: 'localCopilot.generateFromComment' },
  { key: 'A', label: 'Ask the codebase…', icon: 'search', detail: '@codebase question over the local index', command: 'localCopilot.askCodebase' },
  { key: 'P', label: 'Results panel', icon: 'layout-panel-right', detail: 'show previous answers', command: 'localCopilot.openPanel' },
  { key: 'B', label: 'Dashboard', icon: 'dashboard', detail: 'models, privacy, metrics', command: 'localCopilot.openDashboard' },
];

type Item = vscode.QuickPickItem & { command: string };

/** Ctrl+Alt+L: every action, each with a one-letter shortcut. */
export function showActionMenu(): void {
  const qp = vscode.window.createQuickPick<Item>();
  qp.title = 'Local Copilot';
  qp.placeholder = 'Press a letter (E explain · V review · S security · T tests · R refactor · F fix · D docs · G generate · A ask)';
  qp.items = ACTIONS.map((a) => ({ label: `$(${a.icon}) ${a.label}`, description: `[${a.key}]`, detail: a.detail, command: a.command }));
  const run = (command: string) => {
    qp.hide();
    void vscode.commands.executeCommand(command);
  };
  qp.onDidChangeValue((value) => {
    if (value.length !== 1) return;
    const entry = ACTIONS.find((a) => a.key.toLowerCase() === value.toLowerCase());
    if (entry) run(entry.command);
  });
  qp.onDidAccept(() => {
    const item = qp.selectedItems[0] ?? qp.activeItems[0];
    if (item) run(item.command);
  });
  qp.onDidHide(() => qp.dispose());
  qp.show();
}

/** Status bar click. */
export async function showStatusMenu(snoozed: boolean): Promise<void> {
  const language = vscode.window.activeTextEditor?.document.languageId;
  const disabledHere = language ? settings.disabledLanguages().includes(language) : false;
  const items: Item[] = [
    { label: settings.autocompleteEnabled() ? '$(circle-slash) Turn inline completion off' : '$(check) Turn inline completion on', command: 'localCopilot.toggleAutocomplete' },
    ...(language ? [{ label: `$(symbol-file) ${disabledHere ? 'Enable' : 'Disable'} completion for ${language}`, command: 'localCopilot.toggleAutocompleteForLanguage' }] : []),
    { label: snoozed ? '$(debug-start) Resume completions' : '$(debug-pause) Snooze completions for 15 minutes', command: 'localCopilot.snooze' },
    { label: '', kind: vscode.QuickPickItemKind.Separator, command: '' },
    { label: '$(symbol-event) Autocomplete model…', description: settings.autocompleteModel(), command: 'localCopilot.selectAutocompleteModel' },
    { label: '$(hubot) Code intelligence model…', description: settings.chatModel(), command: 'localCopilot.selectChatModel' },
    { label: '$(database) Embedding model…', description: settings.embeddingModel(), command: 'localCopilot.selectEmbeddingModel' },
    { label: '', kind: vscode.QuickPickItemKind.Separator, command: '' },
    { label: '$(sparkle) Actions…', description: 'Ctrl+Alt+L', command: 'localCopilot.showActions' },
    { label: '$(dashboard) Dashboard', command: 'localCopilot.openDashboard' },
    { label: '$(shield) Verify local-only setup', command: 'localCopilot.verifyLocalOnly' },
    { label: '$(refresh) Rebuild codebase index', command: 'localCopilot.rebuildIndex' },
    { label: '$(output) Show logs', command: 'localCopilot.showLogs' },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: 'Local Copilot' });
  if (pick?.command) await vscode.commands.executeCommand(pick.command);
}

const ROLE_LABEL: Record<RoleName, string> = { autocomplete: 'autocomplete', chat: 'code intelligence', embeddings: 'embedding' };

export async function pickModel(models: ModelManager, role: RoleName): Promise<void> {
  let list;
  try {
    list = await models.listModels(true);
  } catch (err) {
    void vscode.window.showErrorMessage(`Local Copilot: cannot list models — ${(err as Error).message}`);
    return;
  }
  const current = role === 'autocomplete' ? settings.autocompleteModel() : role === 'chat' ? settings.chatModel() : settings.embeddingModel();
  const usable = list.filter((m) => !isRemoteModel(m)).filter((m) => {
    const caps = m.capabilities;
    if (!caps) return true;
    return role === 'embeddings' ? caps.includes('embedding') : !caps.includes('embedding');
  });
  const hiddenCloud = list.length - list.filter((m) => !isRemoteModel(m)).length;
  const items: vscode.QuickPickItem[] = usable.map((m) => {
    const size = m.sizeBytes ? `${(m.sizeBytes / 1024 ** 3).toFixed(1)} GB` : undefined;
    const fit = role === 'autocomplete' ? fimSupport(m.name, m.capabilities) : undefined;
    return {
      label: `${m.name === current ? '$(check) ' : ''}${m.name}`,
      description: [m.parameterSize, m.quantization, size].filter(Boolean).join(' · '),
      detail: fit === 'good' ? 'Fill-in-the-middle code model: good for ghost text' : fit === 'possible' ? 'Supports insertion; not specialised for completion' : fit === 'none' ? 'Chat model: poor ghost text' : m.capabilities?.join(', '),
    };
  });
  const pick = await vscode.window.showQuickPick(items, {
    title: `Local Copilot · ${ROLE_LABEL[role]} model`,
    placeHolder: hiddenCloud > 0 ? `${hiddenCloud} cloud model(s) hidden: only local models are allowed` : 'Installed local models',
  });
  if (!pick) return;
  const name = pick.label.replace('$(check) ', '');
  await updateSetting(`${role}.model`, name);
  if (role === 'autocomplete') void models.warmupAutocomplete().catch(() => undefined);
}

const LENS_TITLES: Record<DirectiveKind, string> = {
  security: '$(shield) Local Copilot: security review of the code below',
  review: '$(checklist) Local Copilot: review the code below',
  explain: '$(book) Local Copilot: explain the code below',
  tests: '$(beaker) Local Copilot: write tests for the code below',
  refactor: '$(wand) Local Copilot: refactor the code below',
  document: '$(note) Local Copilot: document the code below',
  fix: '$(debug) Local Copilot: fix the code below',
  generate: '$(sparkle) Local Copilot: generate this (Ctrl+Alt+Enter)',
};

export class DirectiveCodeLens implements vscode.CodeLensProvider {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;

  refresh(): void {
    this.emitter.fire();
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    if (!settings.codeLensEnabled() || document.lineCount > 20_000) return [];
    return findDirectives(document.getText().replace(/\r\n/g, '\n'), document.languageId).map(
      (d) =>
        new vscode.CodeLens(new vscode.Range(d.startLine, 0, d.startLine, 0), {
          title: LENS_TITLES[d.kind],
          command: 'localCopilot.runDirective',
          arguments: [document.uri.toString(), d.startLine],
        }),
    );
  }
}
