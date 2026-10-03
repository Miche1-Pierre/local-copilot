// Message contracts between the extension host and the two webviews.
// Shared by both sides; keep it free of runtime imports.

export type TaskKind = 'explain' | 'review' | 'security' | 'tests' | 'refactor' | 'fix' | 'document' | 'generate' | 'codebase' | 'followup';

export type RunStatus = 'running' | 'done' | 'error' | 'cancelled';

export type FindingSeverity = 'info' | 'low' | 'medium' | 'warning' | 'high' | 'error' | 'critical';

export interface FindingView {
  id: string;
  severity: FindingSeverity;
  title: string;
  /** 1-based, for display and navigation. */
  line?: number;
  endLine?: number;
  /** Workspace-relative POSIX path. */
  path?: string;
  category?: string;
  cwe?: string;
  confidence?: 'low' | 'medium' | 'high';
  source: 'static' | 'llm' | 'static+llm';
  /** Markdown. */
  explanation: string;
  /** Markdown. */
  suggestion?: string;
  verdict?: 'confirmed' | 'false_positive' | 'uncertain';
}

export interface ActionView {
  id: string;
  label: string;
  kind?: 'primary' | 'secondary';
  /** Codicon name without the "codicon-" prefix, e.g. "check". Rendered as text if unknown. */
  icon?: string;
}

export interface RunStats {
  model: string;
  seconds: number;
  outputTokens?: number;
  tokensPerSecond?: number;
}

export interface RunState {
  id: string;
  task: TaskKind;
  title: string;
  /** e.g. "src/auth.py:12-48 · qwen3.5:9b" */
  subtitle?: string;
  status: RunStatus;
  /** Accumulated markdown answer. */
  content: string;
  /** Accumulated reasoning ("thinking") text, shown collapsed. */
  thinking?: string;
  findings?: FindingView[];
  actions?: ActionView[];
  error?: string;
  stats?: RunStats;
  /** For follow-up runs: the run they answer. */
  parentId?: string;
  createdAt: number;
}

/** Host → results panel. */
export type PanelInbound =
  | { type: 'init'; runs: RunState[] }
  | { type: 'runStarted'; run: RunState }
  | { type: 'runDelta'; id: string; content?: string; thinking?: string }
  | { type: 'runUpdate'; id: string; patch: Partial<Omit<RunState, 'id'>> }
  | { type: 'runRemoved'; id: string }
  | { type: 'focusRun'; id: string }
  | { type: 'clear' };

/** Results panel → host. */
export type PanelOutbound =
  | { type: 'ready' }
  | { type: 'action'; runId: string; actionId: string }
  | { type: 'open'; path: string; line?: number; endLine?: number }
  | { type: 'fixFinding'; runId: string; findingId: string }
  | { type: 'cancel'; runId: string }
  | { type: 'followUp'; runId: string; text: string }
  | { type: 'ask'; text: string }
  | { type: 'copy'; text: string }
  | { type: 'insertCode'; code: string }
  | { type: 'remove'; runId: string }
  | { type: 'clearAll' };

export type Role = 'autocomplete' | 'chat' | 'embeddings';

export interface RoleView {
  model: string;
  installed: boolean;
  fimSupport?: 'good' | 'possible' | 'none';
  warning?: string;
}

export interface ModelView {
  name: string;
  sizeGB?: number;
  parameterSize?: string;
  quantization?: string;
  capabilities: string[];
  /** Cloud/remote model: listed but always refused. */
  remote: boolean;
  /** Roles this model is currently assigned to. */
  roles: Role[];
}

export interface RecommendationView {
  model: string;
  reason: string;
  installed: boolean;
  sizeGB?: number;
}

export interface MetricsSummary {
  inline: {
    requests: number;
    shown: number;
    accepted: number;
    acceptanceRate?: number;
    cacheHits: number;
    p50Ms?: number;
    p95Ms?: number;
    avgTokensPerSecond?: number;
    errors: number;
    cancelled: number;
  };
  chat: { requests: number; p50Ms?: number; avgFirstTokenMs?: number; avgTokensPerSecond?: number; errors: number };
  embeddings: { requests: number; vectors: number; errors: number };
  recent: { ts: number; kind: string; model: string; ms: number; tokens?: number; tps?: number; outcome: string }[];
}

export interface DashboardState {
  connection: {
    provider: string;
    endpoint: string;
    reachable: boolean;
    version?: string;
    error?: string;
    localOnly: { ok: boolean; detail: string };
  };
  exposure: { bind: string; bindValue: string; cloudDisabled?: boolean; warnings: string[] };
  roles: Record<Role, RoleView>;
  installed: ModelView[];
  loaded: { name: string; sizeGB: number; vramGB: number; contextLength?: number; until?: string }[];
  hardware?: { summary: string; gpus: { name: string; vramGB: number }[]; ramGB: number; cpu?: string };
  recommendation?: { autocomplete: RecommendationView; chat: RecommendationView; embeddings: RecommendationView; notes: string[] };
  index: {
    enabled: boolean;
    status: 'idle' | 'indexing' | 'embedding' | 'disabled' | 'error';
    files: number;
    symbols: number;
    chunks: number;
    embedded: number;
    message?: string;
  };
  metrics: MetricsSummary;
  pulls: { model: string; status: string; percent?: number; error?: string; done?: boolean }[];
  settings: {
    autocompleteEnabled: boolean;
    multiline: 'auto' | 'always' | 'never';
    debounceMs: number;
    reasoning: 'off' | 'deep' | 'always';
    embeddingsEnabled: boolean;
    securityLlmReview: boolean;
  };
}

/** Host → dashboard. */
export type DashboardInbound =
  | { type: 'state'; state: DashboardState }
  | { type: 'testResult'; role: Role; ok: boolean; message: string }
  | { type: 'toast'; kind: 'info' | 'error'; message: string };

export type QuickSettingKey = keyof DashboardState['settings'];

/** Dashboard → host. */
export type DashboardOutbound =
  | { type: 'ready' }
  | { type: 'refresh' }
  | { type: 'setRole'; role: Role; model: string }
  | { type: 'pull'; model: string }
  | { type: 'cancelPull'; model: string }
  | { type: 'setSetting'; key: QuickSettingKey; value: boolean | number | string }
  | { type: 'testModel'; role: Role }
  | { type: 'rebuildIndex' }
  | { type: 'clearMetrics' }
  | { type: 'verifyLocalOnly' }
  | { type: 'openSettings' }
  | { type: 'openLogs' };
