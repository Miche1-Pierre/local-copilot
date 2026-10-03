// JSON schemas for structured answers (Ollama `format`, OpenAI `response_format`).

export interface ReviewFinding {
  line: number;
  endLine?: number;
  severity: 'info' | 'warning' | 'error';
  category: 'bug' | 'performance' | 'readability' | 'maintainability' | 'security' | 'design';
  title: string;
  explanation: string;
  suggestion?: string;
  excerpt?: string;
}

export interface ReviewAnswer {
  summary: string;
  findings: ReviewFinding[];
}

export interface SecurityFinding {
  line: number;
  endLine?: number;
  severity: 'low' | 'medium' | 'high' | 'critical';
  cwe?: string;
  title: string;
  explanation: string;
  suggestion?: string;
  excerpt?: string;
  confidence?: 'low' | 'medium' | 'high';
}

export interface StaticVerdict {
  id: string;
  verdict: 'confirmed' | 'false_positive' | 'uncertain';
  reason?: string;
}

export interface SecurityAnswer {
  summary: string;
  staticVerdicts: StaticVerdict[];
  findings: SecurityFinding[];
}

export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line: { type: 'integer' },
          endLine: { type: 'integer' },
          severity: { type: 'string', enum: ['info', 'warning', 'error'] },
          category: { type: 'string', enum: ['bug', 'performance', 'readability', 'maintainability', 'security', 'design'] },
          title: { type: 'string' },
          explanation: { type: 'string' },
          suggestion: { type: 'string' },
          excerpt: { type: 'string' },
        },
        required: ['line', 'severity', 'category', 'title', 'explanation'],
      },
    },
  },
  required: ['summary', 'findings'],
} as const;

export const SECURITY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    staticVerdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          verdict: { type: 'string', enum: ['confirmed', 'false_positive', 'uncertain'] },
          reason: { type: 'string' },
        },
        required: ['id', 'verdict'],
      },
    },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          line: { type: 'integer' },
          endLine: { type: 'integer' },
          severity: { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
          cwe: { type: 'string' },
          title: { type: 'string' },
          explanation: { type: 'string' },
          suggestion: { type: 'string' },
          excerpt: { type: 'string' },
          confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
        },
        required: ['line', 'severity', 'title', 'explanation'],
      },
    },
  },
  required: ['summary', 'staticVerdicts', 'findings'],
} as const;
