import type { ContextFile, FimInput, ModelCapability } from '../providers/types';
import { commentSyntaxFor } from '../index/languages';

export type FimTemplateId = 'qwen' | 'starcoder' | 'codellama' | 'deepseek' | 'codestral' | 'codegemma' | 'native' | 'custom';

export interface FimTemplate {
  id: FimTemplateId;
  /** Raw prompt builder. Absent for 'native': the server applies the model template to prefix/suffix. */
  build?: (input: FimInput) => string;
  /** Sequences that end the middle part. */
  stop: string[];
}

const QWEN_STOP = ['<|endoftext|>', '<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', '<|fim_pad|>', '<|repo_name|>', '<|file_sep|>', '<|im_start|>', '<|im_end|>'];
const STARCODER_STOP = ['<|endoftext|>', '<fim_prefix>', '<fim_suffix>', '<fim_middle>', '<file_sep>', '<repo_name>', '<filename>', '<|end_of_text|>'];
const CODELLAMA_STOP = ['<EOT>', '<PRE>', '<SUF>', '<MID>', '</s>'];
const DEEPSEEK_STOP = ['<｜end▁of▁sentence｜>', '<｜fim▁begin｜>', '<｜fim▁hole｜>', '<｜fim▁end｜>', '<|EOT|>'];
const CODESTRAL_STOP = ['[PREFIX]', '[SUFFIX]', '[MIDDLE]', '</s>'];
const CODEGEMMA_STOP = ['<|file_separator|>', '<|fim_prefix|>', '<|fim_suffix|>', '<|fim_middle|>', '<end_of_turn>', '<eos>'];

/** Every special marker we know; anything after one of these in a completion is garbage. */
export const ALL_SPECIAL_MARKERS = Array.from(new Set([...QWEN_STOP, ...STARCODER_STOP, ...CODELLAMA_STOP, ...DEEPSEEK_STOP, ...CODESTRAL_STOP, ...CODEGEMMA_STOP]));

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

/** Renders context files as comments, for formats without repository tokens. */
export function contextAsComments(files: ContextFile[], languageId: string): string {
  if (files.length === 0) return '';
  const { line, blockStart, blockEnd } = commentSyntaxFor(languageId);
  const out: string[] = [];
  for (const f of files) {
    if (line) {
      out.push(`${line} Path: ${f.path}`);
      for (const l of f.content.split('\n')) out.push(`${line} ${l}`);
    } else if (blockStart && blockEnd) {
      out.push(`${blockStart} Path: ${f.path}\n${f.content.replaceAll(blockEnd, '')}\n${blockEnd}`);
    }
    out.push('');
  }
  return `${out.join('\n')}\n`;
}

const qwen: FimTemplate = {
  id: 'qwen',
  stop: QWEN_STOP,
  build: (input) => {
    // Repository-level FIM format of Qwen2.5-Coder: the stable part (repo + context
    // files + current path) comes first so the server can reuse its KV cache.
    let prompt = `<|repo_name|>${input.repoName}\n`;
    for (const f of input.contextFiles) prompt += `<|file_sep|>${f.path}\n${ensureTrailingNewline(f.content)}`;
    prompt += `<|file_sep|>${input.path}\n`;
    return `${prompt}<|fim_prefix|>${input.prefix}<|fim_suffix|>${input.suffix}<|fim_middle|>`;
  },
};

const starcoder: FimTemplate = {
  id: 'starcoder',
  stop: STARCODER_STOP,
  build: (input) => {
    let prompt = input.contextFiles.length > 0 ? `<repo_name>${input.repoName}` : '';
    for (const f of input.contextFiles) prompt += `<file_sep>${f.path}\n${ensureTrailingNewline(f.content)}`;
    if (input.contextFiles.length > 0) prompt += '<file_sep>';
    return `${prompt}<fim_prefix>${input.prefix}<fim_suffix>${input.suffix}<fim_middle>`;
  },
};

const codellama: FimTemplate = {
  id: 'codellama',
  stop: CODELLAMA_STOP,
  build: (input) => `<PRE> ${contextAsComments(input.contextFiles, input.languageId)}${input.prefix} <SUF>${input.suffix} <MID>`,
};

const deepseek: FimTemplate = {
  id: 'deepseek',
  stop: DEEPSEEK_STOP,
  build: (input) => `<｜fim▁begin｜>${contextAsComments(input.contextFiles, input.languageId)}${input.prefix}<｜fim▁hole｜>${input.suffix}<｜fim▁end｜>`,
};

const codestral: FimTemplate = {
  id: 'codestral',
  stop: CODESTRAL_STOP,
  build: (input) => `[SUFFIX]${input.suffix}[PREFIX]${contextAsComments(input.contextFiles, input.languageId)}${input.prefix}`,
};

const codegemma: FimTemplate = {
  id: 'codegemma',
  stop: CODEGEMMA_STOP,
  build: (input) => `<|fim_prefix|>${contextAsComments(input.contextFiles, input.languageId)}${input.prefix}<|fim_suffix|>${input.suffix}<|fim_middle|>`,
};

const native: FimTemplate = { id: 'native', stop: [] };

export function customTemplate(pattern: string, stop: string[]): FimTemplate {
  return {
    id: 'custom',
    stop,
    build: (input) =>
      pattern
        .replaceAll('{context}', contextAsComments(input.contextFiles, input.languageId))
        .replaceAll('{path}', input.path)
        .replaceAll('{prefix}', input.prefix)
        .replaceAll('{suffix}', input.suffix),
  };
}

const BUILTIN: Record<Exclude<FimTemplateId, 'custom'>, FimTemplate> = { qwen, starcoder, codellama, deepseek, codestral, codegemma, native };

export function builtinTemplate(id: Exclude<FimTemplateId, 'custom'>): FimTemplate {
  return BUILTIN[id];
}

/** Picks the FIM format from the model name; falls back on the server's native suffix support. */
export function detectFimTemplate(modelName: string, capabilities?: ModelCapability[]): Exclude<FimTemplateId, 'custom'> {
  const n = modelName.toLowerCase();
  if (/codeqwen/.test(n)) return 'starcoder';
  if (/qwen[\d.]*-?coder/.test(n)) return 'qwen';
  if (/starcoder|granite|stable-?code|santacoder|refact/.test(n)) return 'starcoder';
  if (/codellama|code-llama/.test(n)) return 'codellama';
  if (/deepseek-coder/.test(n)) return 'deepseek';
  if (/codestral/.test(n)) return 'codestral';
  if (/codegemma/.test(n)) return 'codegemma';
  return capabilities?.includes('insert') ? 'native' : 'qwen';
}

export type FimSupport = 'good' | 'possible' | 'none';

/**
 * How well a model is expected to handle fill-in-the-middle. Chat/instruct
 * models without FIM training produce poor ghost text; we warn about them.
 */
export function fimSupport(modelName: string, capabilities?: ModelCapability[]): FimSupport {
  const n = modelName.toLowerCase();
  if (capabilities?.includes('embedding')) return 'none';
  if (/coder|starcoder|codellama|codestral|codegemma|granite.*code|stable-?code|deepseek-coder/.test(n)) {
    return /instruct|chat/.test(n) ? 'possible' : 'good';
  }
  if (capabilities?.includes('insert')) return 'possible';
  return 'none';
}
