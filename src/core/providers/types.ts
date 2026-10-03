import type { FimTemplate } from '../fim/templates';

export type ProviderKind = 'ollama' | 'lmstudio' | 'llamacpp' | 'openai-compatible';

export const DEFAULT_ENDPOINTS: Record<ProviderKind, string> = {
  ollama: 'http://127.0.0.1:11434',
  lmstudio: 'http://127.0.0.1:1234',
  llamacpp: 'http://127.0.0.1:8080',
  'openai-compatible': 'http://127.0.0.1:8000',
};

/** Capability names follow Ollama's vocabulary. */
export type ModelCapability = 'completion' | 'insert' | 'embedding' | 'thinking' | 'tools' | 'vision';

export interface ModelInfo {
  name: string;
  sizeBytes?: number;
  family?: string;
  parameterSize?: string;
  quantization?: string;
  contextLength?: number;
  capabilities?: ModelCapability[];
  /** Served by a remote backend (cloud). Such models are refused by policy. */
  remote?: boolean;
}

export interface ServerInfo {
  kind: ProviderKind;
  baseUrl: string;
  version?: string;
}

export interface LoadedModel {
  name: string;
  sizeBytes: number;
  vramBytes: number;
  contextLength?: number;
  expiresAt?: string;
}

export interface SamplingOptions {
  maxTokens: number;
  temperature?: number;
  topP?: number;
  topK?: number;
  repeatPenalty?: number;
  stop?: string[];
  /** Context window (num_ctx). Keep it constant per model: changing it reloads the model. */
  contextLength?: number;
  /** Layers offloaded to the GPU (num_gpu). Undefined lets the server decide. */
  gpuLayers?: number;
  keepAlive?: string;
  seed?: number;
}

export interface GenerationStats {
  model: string;
  promptTokens?: number;
  outputTokens?: number;
  firstTokenMs?: number;
  totalMs: number;
  loadMs?: number;
  promptEvalMs?: number;
  evalMs?: number;
  tokensPerSecond?: number;
  doneReason?: string;
  stoppedEarly?: boolean;
}

export interface GenerationResult {
  text: string;
  thinking?: string;
  stats: GenerationStats;
}

export interface Delta {
  text?: string;
  thinking?: string;
}

/** Called for every streamed piece. Return 'stop' to end generation early (the request is aborted). */
export type DeltaHandler = (delta: Delta, accumulated: string) => void | 'stop';

export interface ContextFile {
  /** Workspace-relative POSIX path. */
  path: string;
  content: string;
}

export interface FimInput {
  prefix: string;
  suffix: string;
  /** Workspace-relative POSIX path of the edited file. */
  path: string;
  languageId: string;
  repoName: string;
  contextFiles: ContextFile[];
}

export interface FimRequest {
  model: string;
  input: FimInput;
  template: FimTemplate;
  options: SamplingOptions;
  signal?: AbortSignal;
  onDelta?: DeltaHandler;
}

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export type ThinkSetting = boolean | 'low' | 'medium' | 'high';

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  options: SamplingOptions;
  /** undefined = leave the model default; true/false = force (only for thinking-capable models). */
  think?: ThinkSetting;
  /** JSON schema for structured output. */
  jsonSchema?: Record<string, unknown>;
  signal?: AbortSignal;
  onDelta?: DeltaHandler;
}

export interface EmbedRequest {
  model: string;
  inputs: string[];
  keepAlive?: string;
  signal?: AbortSignal;
}

export interface PullProgress {
  status: string;
  total?: number;
  completed?: number;
}

export interface ModelProvider {
  readonly kind: ProviderKind;
  readonly baseUrl: string;
  serverInfo(signal?: AbortSignal): Promise<ServerInfo>;
  listModels(signal?: AbortSignal): Promise<ModelInfo[]>;
  loadedModels?(signal?: AbortSignal): Promise<LoadedModel[]>;
  fim(req: FimRequest): Promise<GenerationResult>;
  chat(req: ChatRequest): Promise<GenerationResult>;
  embed(req: EmbedRequest): Promise<number[][]>;
  /** Loads a model ahead of the first request. */
  warmup?(model: string, keepAlive: string, contextLength?: number, signal?: AbortSignal): Promise<void>;
  /** Asks the server to download a model (the server talks to its registry, not this extension). */
  pull?(model: string, onProgress: (p: PullProgress) => void, signal?: AbortSignal): Promise<void>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: 'unreachable' | 'model_not_found' | 'http' | 'bad_response' | 'unsupported' | 'timeout',
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
