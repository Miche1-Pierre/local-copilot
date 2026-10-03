import * as vscode from 'vscode';
import type { InlineSettings } from '../core/completion/engine';
import type { FimTemplateId } from '../core/fim/templates';
import type { ProviderKind } from '../core/providers/types';
import type { TaskKind } from '../webview/protocol';

export const SECTION = 'localCopilot';

export type Reasoning = 'off' | 'deep' | 'always';
export type RoleName = 'autocomplete' | 'chat' | 'embeddings';

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration(SECTION);
}

function get<T>(key: string, fallback: T): T {
  return cfg().get<T>(key, fallback);
}

export interface ConnectionSettings {
  kind: ProviderKind;
  endpoint: string;
}

export function connectionFor(role: RoleName): ConnectionSettings {
  const kind = get<ProviderKind>('provider', 'ollama');
  const endpoint = get<string>('endpoint', '');
  if (role === 'embeddings') return { kind, endpoint };
  const overrideKind = get<string>(`${role}.provider`, 'inherit');
  const overrideEndpoint = get<string>(`${role}.endpoint`, '');
  const finalKind = overrideKind && overrideKind !== 'inherit' ? (overrideKind as ProviderKind) : kind;
  return { kind: finalKind, endpoint: overrideEndpoint || (finalKind === kind ? endpoint : '') };
}

export const settings = {
  autocompleteEnabled: () => get('autocomplete.enabled', true),
  autocompleteModel: () => get('autocomplete.model', 'qwen2.5-coder:3b-base'),
  fimTemplate: () => get<FimTemplateId | 'auto'>('autocomplete.fimTemplate', 'auto'),
  customTemplate: () => get('autocomplete.customTemplate', '<|fim_prefix|>{context}{prefix}<|fim_suffix|>{suffix}<|fim_middle|>'),
  customStop: () => get<string[]>('autocomplete.customStop', []),
  disabledLanguages: () => get<string[]>('autocomplete.disabledLanguages', ['plaintext', 'markdown', 'scminput', 'log', 'csv', 'tsv']),
  inline: (): InlineSettings => ({
    model: get('autocomplete.model', 'qwen2.5-coder:3b-base'),
    debounceMs: get('autocomplete.debounceMs', 120),
    multiline: get('autocomplete.multiline', 'auto'),
    maxTokens: get('autocomplete.maxTokens', 48),
    maxTokensMultiline: get('autocomplete.maxTokensMultiline', 256),
    maxLines: get('autocomplete.maxLines', 30),
    temperature: get('autocomplete.temperature', 0.1),
    contextLength: get('autocomplete.contextLength', 4096),
    prefixTokens: get('autocomplete.prefixTokens', 1600),
    suffixTokens: get('autocomplete.suffixTokens', 400),
    repoContextTokens: get('autocomplete.repoContextTokens', 1000),
    keepAlive: get('autocomplete.keepAlive', '30m'),
  }),
  chatModel: () => get('chat.model', 'qwen3.5:9b'),
  taskModel: (task: TaskKind): string => {
    const overrides = get<Record<string, string>>('chat.taskModels', {});
    const key = task === 'followup' ? 'codebase' : task;
    return overrides[key]?.trim() || get('chat.model', 'qwen3.5:9b');
  },
  reasoning: () => get<Reasoning>('chat.reasoning', 'off'),
  chatContextLength: () => get('chat.contextLength', 16384),
  chatGpuLayers: () => get('chat.gpuLayers', -1),
  chatMaxOutputTokens: () => get('chat.maxOutputTokens', 4096),
  chatTemperature: () => get('chat.temperature', 0.2),
  chatKeepAlive: () => get('chat.keepAlive', '10m'),
  answerLanguage: (): string => {
    const configured = get('chat.language', 'auto').trim();
    if (configured && configured.toLowerCase() !== 'auto') return configured;
    return languageName(vscode.env.language);
  },
  codeLensEnabled: () => get('codeLens.enabled', true),
  embeddingsEnabled: () => get('embeddings.enabled', true),
  embeddingModel: () => get('embeddings.model', 'qwen3-embedding:0.6b'),
  indexEnabled: () => get('index.enabled', true),
  indexInclude: () => get<string[]>('index.include', []),
  indexExclude: () => get<string[]>('index.exclude', []),
  respectGitignore: () => get('index.respectGitignore', true),
  maxFiles: () => get('index.maxFiles', 6000),
  maxFileSizeKB: () => get('index.maxFileSizeKB', 512),
  securityLlmReview: () => get('security.llmReview', true),
  scanOnSave: () => get('security.scanOnSave', false),
  statusBarEnabled: () => get('statusBar.enabled', true),
  metricsEnabled: () => get('metrics.enabled', true),
};

export async function updateSetting(key: string, value: unknown): Promise<void> {
  await cfg().update(key, value, vscode.ConfigurationTarget.Global);
}

const LANGUAGES: Record<string, string> = {
  en: 'English',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  'pt-br': 'Brazilian Portuguese',
  nl: 'Dutch',
  pl: 'Polish',
  ru: 'Russian',
  uk: 'Ukrainian',
  tr: 'Turkish',
  ja: 'Japanese',
  ko: 'Korean',
  'zh-cn': 'Simplified Chinese',
  'zh-tw': 'Traditional Chinese',
  cs: 'Czech',
  hu: 'Hungarian',
};

function languageName(locale: string): string {
  const l = locale.toLowerCase();
  return LANGUAGES[l] ?? LANGUAGES[l.split('-')[0]] ?? 'English';
}
