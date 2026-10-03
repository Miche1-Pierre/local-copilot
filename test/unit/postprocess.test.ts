import { describe, expect, it } from 'vitest';
import { chooseMode, isAfterComment, shouldTrigger, type LineContext } from '../../src/core/fim/heuristics';
import { cutAtBlockEnd, postProcessCompletion, shouldStopEarly, stripSpecialTokens, type PostProcessContext } from '../../src/core/fim/postprocess';

function ctx(over: Partial<PostProcessContext> = {}): PostProcessContext {
  return { mode: 'multi', linePrefix: '', lineSuffix: '', nextLines: [], previousLines: [], maxLines: 30, ...over };
}

function line(over: Partial<LineContext> = {}): LineContext {
  return { linePrefix: '', lineSuffix: '', previousLines: [], nextLines: [], languageId: 'typescript', ...over };
}

describe('heuristics', () => {
  it('does not trigger in the middle of real code', () => {
    expect(shouldTrigger(line({ linePrefix: 'const x = ', lineSuffix: 'foo(bar);' }), false).trigger).toBe(false);
    expect(shouldTrigger(line({ linePrefix: 'foo(', lineSuffix: ');' }), false).trigger).toBe(true);
    expect(shouldTrigger(line({ linePrefix: 'const x = ', lineSuffix: 'foo(bar);' }), true).trigger).toBe(true);
  });

  it('chooses multi-line after openers and on empty lines', () => {
    expect(chooseMode(line({ linePrefix: 'function f() {' }), 'auto')).toBe('multi');
    expect(chooseMode(line({ linePrefix: 'def calculate_tax(' }), 'auto')).toBe('multi');
    expect(chooseMode(line({ linePrefix: '    ' }), 'auto')).toBe('multi');
    expect(chooseMode(line({ linePrefix: 'const total = ' }), 'auto')).toBe('single');
    expect(chooseMode(line({ linePrefix: 'foo(', lineSuffix: ')' }), 'auto')).toBe('single');
    expect(chooseMode(line({ linePrefix: 'x' }), 'always')).toBe('multi');
  });

  it('detects the comment-to-code situation', () => {
    expect(isAfterComment(line({ linePrefix: '', previousLines: ['', '// Sort a list of integers'] }))).toBe(true);
    expect(isAfterComment(line({ languageId: 'python', previousLines: ['# Implement a binary search'] }))).toBe(true);
    expect(isAfterComment(line({ previousLines: ['const a = 1;'] }))).toBe(false);
  });
});

describe('stripSpecialTokens', () => {
  it('cuts at the first special marker', () => {
    expect(stripSpecialTokens('return a + b<|endoftext|>garbage')).toBe('return a + b');
    expect(stripSpecialTokens('x = 1\r\n<|file_sep|>other.py')).toBe('x = 1\n');
  });
});

describe('postProcessCompletion — single line', () => {
  it('keeps the first line only', () => {
    expect(postProcessCompletion('Math.min(a, b);\nconsole.log(1);', ctx({ mode: 'single', linePrefix: 'return ' }))?.text).toBe('Math.min(a, b);');
  });

  it('drops completions that start a new line after a complete line', () => {
    expect(postProcessCompletion('\nfoo();', ctx({ mode: 'single', linePrefix: 'bar();' }))).toBeUndefined();
  });

  it('reuses closing punctuation after the cursor', () => {
    const full = postProcessCompletion('a, b)', ctx({ mode: 'single', linePrefix: 'add(', lineSuffix: ')' }));
    expect(full).toEqual({ text: 'a, b)', replaceLineSuffix: true });
    const partial = postProcessCompletion('a, b)', ctx({ mode: 'single', linePrefix: 'add(', lineSuffix: ');' }));
    expect(partial).toEqual({ text: 'a, b', replaceLineSuffix: false });
    const none = postProcessCompletion('a, b', ctx({ mode: 'single', linePrefix: 'add(', lineSuffix: ')' }));
    expect(none).toEqual({ text: 'a, b', replaceLineSuffix: false });
  });

  it('rejects repetition of the previous line', () => {
    expect(postProcessCompletion('total += item.price;', ctx({ mode: 'single', linePrefix: '    ', previousLines: ['    total += item.price;'] }))).toBeUndefined();
  });
});

describe('postProcessCompletion — blocks', () => {
  it('stops a Python body at the dedent', () => {
    const r = postProcessCompletion('\n    return a + b\n\ndef sub(a, b):\n    return a - b\n', ctx({ linePrefix: 'def add(a, b):' }));
    expect(r?.text).toBe('\n    return a + b');
  });

  it('keeps the closing brace of a block it opened when the suffix lacks it', () => {
    const r = postProcessCompletion('\n    return 1;\n}\n\nfunction g() {', ctx({ linePrefix: 'function f() {', nextLines: ['', 'export {}'] }));
    expect(r?.text).toBe('\n    return 1;\n}');
  });

  it('drops a closing brace the suffix already has (auto-closed brackets)', () => {
    const r = postProcessCompletion('currentHealth -= amount;\n        if (currentHealth < 0) currentHealth = 0;\n    }\n', ctx({ linePrefix: '        ', nextLines: ['    }', '', '    public bool IsDead => currentHealth <= 0;'] }));
    expect(r?.text).toBe('currentHealth -= amount;\n        if (currentHealth < 0) currentHealth = 0;');
  });

  it('never closes the enclosing method again when it is closed further down', () => {
    const r = postProcessCompletion('if (x) return;\n            y = 2;\n        }\n', ctx({ linePrefix: '            ', nextLines: ['            z = 3;', '            w = 4;', '        }', '    }'] }));
    expect(r?.text).toBe('if (x) return;\n            y = 2;');
  });

  it('still closes a block when nothing below does (writing at the end of a file)', () => {
    const r = postProcessCompletion('return a;\n}\n', ctx({ linePrefix: '    ', nextLines: [] }));
    expect(r?.text).toBe('return a;\n}');
  });

  it('stops when the model starts re-typing the code below the cursor', () => {
    const r = postProcessCompletion('var a = Compute();\n        Apply(a, settings.Strength);\n        Log("done");', ctx({ linePrefix: '        ', nextLines: ['        Apply(a, settings.Strength);', '        Log("done");', '    }'] }));
    expect(r?.text).toBe('var a = Compute();');
  });

  it('caps the number of lines', () => {
    const many = ['x0 = 0', ...Array.from({ length: 49 }, (_, i) => `    x${i + 1} = ${i + 1}`)].join('\n');
    const r = postProcessCompletion(many, ctx({ linePrefix: '    ', maxLines: 5 }));
    expect(r?.text.split('\n')).toHaveLength(5);
  });

  it('rejects regurgitation of the next line', () => {
    expect(postProcessCompletion('return result;', ctx({ linePrefix: '    ', nextLines: ['    return result;', '}'] }))).toBeUndefined();
  });

  it('implements a comment instruction (binary search)', () => {
    const raw = '    left, right = 0, len(arr) - 1\n    while left <= right:\n        mid = (left + right) // 2\n        if arr[mid] == target:\n            return mid\n        elif arr[mid] < target:\n            left = mid + 1\n        else:\n            right = mid - 1\n    return -1\n';
    const r = postProcessCompletion(raw, ctx({ linePrefix: '', previousLines: ['# Implement a binary search over the sorted array', 'def search(arr, target):'], nextLines: ['', '', 'if __name__ == "__main__":'] }));
    expect(r?.text.split('\n')).toHaveLength(10);
    expect(r?.text.endsWith('return -1')).toBe(true);
  });
});

describe('streaming helpers', () => {
  it('stops early once a single line is complete', () => {
    expect(shouldStopEarly('foo()', ctx({ mode: 'single', linePrefix: 'x = ' }))).toBe(false);
    expect(shouldStopEarly('foo()\nbar', ctx({ mode: 'single', linePrefix: 'x = ' }))).toBe(true);
  });

  it('stops early when a block is left', () => {
    const c = ctx({ linePrefix: 'def f():' });
    expect(shouldStopEarly('\n    return 1\n', c)).toBe(false);
    expect(shouldStopEarly('\n    return 1\ndef g():\n', c)).toBe(true);
  });

  it('cutAtBlockEnd ignores the trailing incomplete line when streaming', () => {
    expect(cutAtBlockEnd(['', '    a = 1', 'def'], ctx({ linePrefix: 'def f():' }), true).truncated).toBe(false);
  });
});
