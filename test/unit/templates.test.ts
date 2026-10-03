import { describe, expect, it } from 'vitest';
import { builtinTemplate, contextAsComments, customTemplate, detectFimTemplate, fimSupport } from '../../src/core/fim/templates';
import type { FimInput } from '../../src/core/providers/types';

const input: FimInput = {
  prefix: 'def add(a, b):\n    ',
  suffix: '\n\nprint(add(1, 2))\n',
  path: 'src/math.py',
  languageId: 'python',
  repoName: 'demo',
  contextFiles: [{ path: 'src/util.py', content: 'def helper():\n    pass' }],
};

describe('FIM templates', () => {
  it('builds the Qwen repository-level format with stable context first', () => {
    const p = builtinTemplate('qwen').build!(input);
    expect(p).toBe(
      '<|repo_name|>demo\n<|file_sep|>src/util.py\ndef helper():\n    pass\n<|file_sep|>src/math.py\n<|fim_prefix|>def add(a, b):\n    <|fim_suffix|>\n\nprint(add(1, 2))\n<|fim_middle|>',
    );
    expect(builtinTemplate('qwen').stop).toContain('<|endoftext|>');
  });

  it('builds StarCoder, CodeLlama, DeepSeek and Codestral formats', () => {
    expect(builtinTemplate('starcoder').build!(input)).toContain('<file_sep>src/util.py\n');
    expect(builtinTemplate('starcoder').build!(input)).toMatch(/<fim_prefix>def add[\s\S]*<fim_suffix>[\s\S]*<fim_middle>$/);
    expect(builtinTemplate('codellama').build!(input)).toMatch(/^<PRE> # Path: src\/util.py[\s\S]* <SUF>[\s\S]* <MID>$/);
    expect(builtinTemplate('deepseek').build!(input)).toContain('<｜fim▁hole｜>');
    expect(builtinTemplate('codestral').build!(input).startsWith('[SUFFIX]\n\nprint')).toBe(true);
  });

  it('leaves native mode to the server', () => {
    expect(builtinTemplate('native').build).toBeUndefined();
  });

  it('supports custom templates', () => {
    const t = customTemplate('<pre>{prefix}<suf>{suffix}<mid>', ['<eot>']);
    expect(t.build!(input)).toBe('<pre>def add(a, b):\n    <suf>\n\nprint(add(1, 2))\n<mid>');
    expect(t.stop).toEqual(['<eot>']);
  });

  it('renders context as comments in the file language', () => {
    expect(contextAsComments(input.contextFiles, 'python')).toContain('# Path: src/util.py\n# def helper():');
    expect(contextAsComments(input.contextFiles, 'csharp')).toContain('// Path: src/util.py');
    expect(contextAsComments([], 'python')).toBe('');
  });
});

describe('detectFimTemplate', () => {
  it('maps model families', () => {
    expect(detectFimTemplate('qwen2.5-coder:3b-base')).toBe('qwen');
    expect(detectFimTemplate('qwen3-coder:30b')).toBe('qwen');
    expect(detectFimTemplate('codeqwen:7b')).toBe('starcoder');
    expect(detectFimTemplate('starcoder2:7b')).toBe('starcoder');
    expect(detectFimTemplate('granite-code:8b')).toBe('starcoder');
    expect(detectFimTemplate('codellama:7b-code')).toBe('codellama');
    expect(detectFimTemplate('deepseek-coder:6.7b-base')).toBe('deepseek');
    expect(detectFimTemplate('codestral:22b')).toBe('codestral');
    expect(detectFimTemplate('codegemma:2b')).toBe('codegemma');
    expect(detectFimTemplate('mystery:1b', ['completion', 'insert'])).toBe('native');
  });
});

describe('fimSupport', () => {
  it('distinguishes completion models from chat models', () => {
    expect(fimSupport('qwen2.5-coder:3b-base', ['completion', 'insert'])).toBe('good');
    expect(fimSupport('qwen2.5-coder:7b-instruct')).toBe('possible');
    expect(fimSupport('qwen3.5:9b', ['completion', 'thinking'])).toBe('none');
    expect(fimSupport('qwen3-embedding:0.6b', ['embedding'])).toBe('none');
  });
});
