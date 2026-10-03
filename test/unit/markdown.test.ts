import { describe, expect, it } from 'vitest';
import { escapeHtml, renderMarkdown } from '../../src/webview/markdown';

// The renderer's whole output vocabulary. Anything else in the output would come from the input.
const ALLOWED_TAGS = new Set([
  'p', 'br', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'strong', 'em', 'del', 'code', 'pre', 'ul', 'ol', 'li',
  'blockquote', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'div', 'span', 'a',
]);
const ALLOWED_ATTRS = new Set(['class', 'data-lang', 'href', 'data-path', 'data-line', 'data-end', 'title', 'start', 'aria-hidden']);

/** Parses the tags of renderer output (attribute values never contain raw quotes or brackets). */
function tags(html: string): { name: string; closing: boolean; attrs: Record<string, string> }[] {
  const out: { name: string; closing: boolean; attrs: Record<string, string> }[] = [];
  for (const m of html.matchAll(/<(\/?)([A-Za-z][A-Za-z0-9]*)([^>]*)>/g)) {
    const attrs: Record<string, string> = {};
    const rest = m[3].replace(/\s([a-z-]+)="([^"]*)"/g, (_all, name: string, value: string) => {
      attrs[name] = value;
      return '';
    });
    // Whatever is left inside a tag must be whitespace: no unquoted / injected attributes.
    expect(rest.trim()).toBe('');
    out.push({ name: m[2].toLowerCase(), closing: m[1] === '/', attrs });
  }
  return out;
}

function assertSafe(html: string): void {
  // A "<" that does not start a tag would mean raw input leaked.
  expect(html).not.toMatch(/<(?![A-Za-z/])/);
  for (const t of tags(html)) {
    expect(ALLOWED_TAGS.has(t.name), `tag <${t.name}>`).toBe(true);
    for (const [name, value] of Object.entries(t.attrs)) {
      expect(ALLOWED_ATTRS.has(name), `attribute ${name}`).toBe(true);
      expect(value).not.toMatch(/[<>"]/);
      if (name === 'href') expect(value).toBe('#');
    }
    if (t.name === 'a' && !t.closing) expect(t.attrs.class).toBe('file-ref');
  }
}

function refs(html: string): { path: string; line?: string; end?: string; text: string }[] {
  return [...html.matchAll(/<a class="file-ref" href="#" data-path="([^"]*)"(?: data-line="(\d+)")?(?: data-end="(\d+)")?[^>]*>([^<]*)<\/a>/g)].map(
    (m) => ({ path: m[1], line: m[2], end: m[3], text: m[4] }),
  );
}

describe('escapeHtml', () => {
  it('escapes the five HTML special characters', () => {
    expect(escapeHtml(`<a href="x" title='y'>&</a>`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;&lt;/a&gt;');
  });

  it('returns plain text unchanged', () => {
    expect(escapeHtml('plain text 123')).toBe('plain text 123');
  });
});

describe('renderMarkdown: untrusted input', () => {
  it('escapes script tags', () => {
    const html = renderMarkdown('Hello <script>alert(1)</script> world');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    assertSafe(html);
  });

  it('escapes event-handler attributes', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>\n\n<div onclick="steal()">x</div>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<div onclick');
    assertSafe(html);
  });

  it('cannot inject attributes through a code fence language', () => {
    const html = renderMarkdown('```"><img src=x onerror=alert(1)>\nconsole.log(1)\n```');
    expect(html).not.toContain('<img');
    expect(html).toMatch(/^<pre class="code-block" data-lang="[\w+#.-]*"><code>console\.log\(1\)<\/code><\/pre>$/);
    assertSafe(html);
  });

  it('escapes HTML inside code blocks and code spans', () => {
    const html = renderMarkdown('`<b>x</b>`\n\n```html\n<iframe src="x"></iframe>\n```');
    expect(html).toContain('<code>&lt;b&gt;x&lt;/b&gt;</code>');
    expect(html).toContain('<code>&lt;iframe src=&quot;x&quot;&gt;&lt;/iframe&gt;</code>');
    assertSafe(html);
  });

  it('renders javascript: and other links as inert text', () => {
    const html = renderMarkdown('[click](javascript:alert(1)) [x](http://a.example/" onmouseover="alert(1))');
    expect(html).not.toMatch(/href="(?!#)/);
    expect(html).toContain('<span class="ext-link">click (javascript:alert(1))</span>');
    assertSafe(html);
  });

  it('never emits foreign tags or attributes for hostile soup', () => {
    // Deterministic pseudo-random mix of markdown syntax and HTML metacharacters.
    const pieces = ['<', '>', '&', '"', "'", '`', '```', '*', '_', '[', ']', '(', ')', '|', '-', '#', '>', '\n', ' ', 'a', 'src/x.ts:3', 'http://e.x/', '\\', '~~', '1.', '<img onerror=x>', '</code>', '"><svg>'];
    let seed = 42;
    const rand = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    for (let doc = 0; doc < 300; doc++) {
      let md = '';
      const len = 5 + Math.floor(rand() * 60);
      for (let k = 0; k < len; k++) md += pieces[Math.floor(rand() * pieces.length)];
      assertSafe(renderMarkdown(md));
    }
  });
});

describe('renderMarkdown: blocks', () => {
  it('renders ATX headings', () => {
    expect(renderMarkdown('# Title\n### Sub ###\n####### not a heading')).toBe('<h1>Title</h1><h3>Sub</h3><p>####### not a heading</p>');
  });

  it('keeps line breaks inside paragraphs and separates paragraphs', () => {
    expect(renderMarkdown('line one\nline two\n\nnext')).toBe('<p>line one<br>line two</p><p>next</p>');
  });

  it('renders nested unordered lists by indentation', () => {
    expect(renderMarkdown('- a\n  - b\n    - c\n- d')).toBe('<ul><li>a<ul><li>b<ul><li>c</li></ul></li></ul></li><li>d</li></ul>');
  });

  it('renders ordered lists, keeping the start number', () => {
    expect(renderMarkdown('1. one\n2. two')).toBe('<ol><li>one</li><li>two</li></ol>');
    expect(renderMarkdown('3. three\n4. four')).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
  });

  it('nests a bullet list under an ordered item indented by two spaces', () => {
    expect(renderMarkdown('1. step\n  - detail\n2. next')).toBe('<ol><li>step<ul><li>detail</li></ul></li><li>next</li></ol>');
  });

  it('keeps a fenced block inside a list item', () => {
    const html = renderMarkdown('1. Install:\n   ```bash\n   npm i\n   ```\n2. Run');
    expect(html).toBe('<ol><li>Install:<pre class="code-block" data-lang="bash"><code>npm i</code></pre></li><li>Run</li></ol>');
  });

  it('wraps paragraphs of loose lists', () => {
    expect(renderMarkdown('- a\n\n- b')).toBe('<ul><li><p>a</p></li><li><p>b</p></li></ul>');
  });

  it('renders GFM tables with alignment', () => {
    const html = renderMarkdown('| Name | Count |\n|:-----|------:|\n| `a|b` | **2** |\n| c |');
    expect(html).toBe(
      '<div class="table-wrap"><table><thead><tr><th>Name</th><th class="al-r">Count</th></tr></thead>' +
        '<tbody><tr><td><code>a|b</code></td><td class="al-r"><strong>2</strong></td></tr>' +
        '<tr><td>c</td><td class="al-r"></td></tr></tbody></table></div>',
    );
  });

  it('does not treat a lone pipe line as a table', () => {
    expect(renderMarkdown('a | b\nnext line')).toBe('<p>a | b<br>next line</p>');
  });

  it('renders blockquotes with nested blocks', () => {
    expect(renderMarkdown('> quoted **text**\n> - item')).toBe('<blockquote><p>quoted <strong>text</strong></p><ul><li>item</li></ul></blockquote>');
  });

  it('renders horizontal rules', () => {
    expect(renderMarkdown('above\n\n---\n\n***\nbelow')).toBe('<p>above</p><hr><hr><p>below</p>');
  });

  it('renders fenced code blocks with ``` and ~~~', () => {
    expect(renderMarkdown('```ts\nconst a = 1;\n\nif (a < 2) {}\n```')).toBe(
      '<pre class="code-block" data-lang="ts"><code>const a = 1;\n\nif (a &lt; 2) {}</code></pre>',
    );
    expect(renderMarkdown('~~~\nplain\n~~~')).toBe('<pre class="code-block" data-lang=""><code>plain</code></pre>');
  });

  it('keeps a language like c++ or c# and drops a filename suffix', () => {
    expect(renderMarkdown('```c++\nx\n```')).toContain('data-lang="c++"');
    expect(renderMarkdown('```cs:Assets/Player.cs\nx\n```')).toContain('data-lang="cs"');
  });
});

describe('renderMarkdown: streaming', () => {
  it('renders an unclosed fence as a code block', () => {
    expect(renderMarkdown('Here:\n```python\ndef f():\n    return 1\n')).toBe(
      '<p>Here:</p><pre class="code-block" data-lang="python"><code>def f():\n    return 1</code></pre>',
    );
  });

  it('hides a half-written closing fence', () => {
    expect(renderMarkdown('```js\nx()\n``')).toBe('<pre class="code-block" data-lang="js"><code>x()</code></pre>');
  });

  it('leaves partial inline syntax as text', () => {
    expect(renderMarkdown('a **bol')).toBe('<p>a **bol</p>');
    expect(renderMarkdown('see [docs](https://exa')).toBe('<p>see [docs](https://exa</p>');
    expect(renderMarkdown('use `foo')).toBe('<p>use `foo</p>');
  });

  it('renders every prefix of a document safely', () => {
    const doc = [
      '# Review of `src/auth/login.ts:12-30`',
      '',
      'The function **does not** validate _input_ (see [OWASP](https://owasp.example/a)).',
      '',
      '1. First issue in src/auth/login.ts:14',
      '   ```ts',
      '   const q = `SELECT * FROM users WHERE id = ${id}`;',
      '   ```',
      '2. Second issue',
      '   - nested <b>html</b>',
      '',
      '| Severity | Line |',
      '|---|---:|',
      '| high | 14 |',
      '',
      '> [!WARNING]',
      '> Fix it ~~later~~ now.',
    ].join('\n');
    for (let i = 0; i <= doc.length; i++) assertSafe(renderMarkdown(doc.slice(0, i)));
  });
});

describe('renderMarkdown: inlines', () => {
  it('renders bold, italic and strikethrough, but not intraword underscores', () => {
    expect(renderMarkdown('**bold** *it* _it2_ ***both*** ~~gone~~ snake_case_name 2*3*4')).toBe(
      '<p><strong>bold</strong> <em>it</em> <em>it2</em> <em><strong>both</strong></em> <del>gone</del> snake_case_name 2<em>3</em>4</p>',
    );
  });

  it('nests emphasis', () => {
    expect(renderMarkdown('**a *b* c**')).toBe('<p><strong>a <em>b</em> c</strong></p>');
  });

  it('renders inline code literally', () => {
    expect(renderMarkdown('`a < b && **c**`')).toBe('<p><code>a &lt; b &amp;&amp; **c**</code></p>');
    expect(renderMarkdown('`` a ` b ``')).toBe('<p><code>a ` b</code></p>');
  });

  it('honours backslash escapes', () => {
    expect(renderMarkdown('\\*not emphasis\\* and \\`not code\\`')).toBe('<p>*not emphasis* and `not code`</p>');
  });

  it('renders links as non-clickable text with their URL', () => {
    const html = renderMarkdown('Read [the docs](https://docs.example.com/x?a=1&b=2 "Title") now.');
    expect(html).toBe('<p>Read <span class="ext-link">the docs (https://docs.example.com/x?a=1&amp;b=2)</span> now.</p>');
    expect(html).not.toContain('href="http');
  });

  it('renders images as text, never as <img>', () => {
    expect(renderMarkdown('![diagram](https://img.example.com/d.png)')).toBe(
      '<p><span class="ext-link">image: diagram (https://img.example.com/d.png)</span></p>',
    );
  });

  it('leaves bare URLs as plain text', () => {
    const html = renderMarkdown('See https://example.com/a_b_c/file.ts:80 and www.example.com/x_y_z.');
    expect(html).toBe('<p>See https://example.com/a_b_c/file.ts:80 and www.example.com/x_y_z.</p>');
  });
});

describe('renderMarkdown: file references', () => {
  it('detects path:line', () => {
    expect(refs(renderMarkdown('Look at src/a/b.ts:12 first.'))).toEqual([{ path: 'src/a/b.ts', line: '12', end: undefined, text: 'src/a/b.ts:12' }]);
  });

  it('detects path#Lline', () => {
    expect(refs(renderMarkdown('In Assets/Player.cs#L40 the bug.'))).toEqual([
      { path: 'Assets/Player.cs', line: '40', end: undefined, text: 'Assets/Player.cs#L40' },
    ]);
  });

  it('detects ranges', () => {
    expect(refs(renderMarkdown('x/y.py:3-9'))).toEqual([{ path: 'x/y.py', line: '3', end: '9', text: 'x/y.py:3-9' }]);
    expect(refs(renderMarkdown('lib/z.go#L10-L20'))).toEqual([{ path: 'lib/z.go', line: '10', end: '20', text: 'lib/z.go#L10-L20' }]);
  });

  it('detects "(line N)" and compiler-style "(N,col)"', () => {
    expect(refs(renderMarkdown('Assets/Scripts/Player.cs (line 40)'))).toEqual([
      { path: 'Assets/Scripts/Player.cs', line: '40', end: undefined, text: 'Assets/Scripts/Player.cs (line 40)' },
    ]);
    expect(refs(renderMarkdown('Assets/Scripts/Enemy.cs(12,5): error CS0103'))[0]).toMatchObject({ path: 'Assets/Scripts/Enemy.cs', line: '12' });
  });

  it('detects references inside inline code', () => {
    const html = renderMarkdown('Open `src/auth/login.ts:12-30`.');
    expect(html).toBe(
      '<p>Open <code><a class="file-ref" href="#" data-path="src/auth/login.ts" data-line="12" data-end="30" ' +
        'title="Open src/auth/login.ts at lines 12-30">src/auth/login.ts:12-30</a></code>.</p>',
    );
  });

  it('accepts a bare file name only with a known code extension', () => {
    expect(refs(renderMarkdown('login.ts:7'))).toEqual([{ path: 'login.ts', line: '7', end: undefined, text: 'login.ts:7' }]);
    expect(refs(renderMarkdown('foo.bar:12'))).toEqual([]);
  });

  it('strips a leading ./ and ignores the column', () => {
    expect(refs(renderMarkdown('./src/main.rs:5:17'))).toEqual([{ path: 'src/main.rs', line: '5', end: undefined, text: './src/main.rs:5:17' }]);
  });

  it('does not match URLs, versions, times or absolute paths', () => {
    for (const text of ['http://x.com/a.ts:80', 'https://h.example/src/a/b.ts:12', 'v1.2.3:4', '1.2.3:4', '12:30', 'localhost:8080', 'example.com:443', '/etc/app/x.conf:3', 'C:\\work\\a.ts:3']) {
      expect(refs(renderMarkdown(text)), text).toEqual([]);
    }
  });

  it('turns a relative link target into a file reference but keeps it non-navigating', () => {
    const html = renderMarkdown('[login](src/auth/login.ts#L12)');
    expect(refs(html)).toEqual([{ path: 'src/auth/login.ts', line: '12', end: undefined, text: 'src/auth/login.ts#L12' }]);
    assertSafe(html);
  });

  it('survives emphasis around a reference with underscores', () => {
    const html = renderMarkdown('**src/my_module/file_name.py:3**');
    expect(html).toContain('<strong><a class="file-ref" href="#" data-path="src/my_module/file_name.py" data-line="3"');
    assertSafe(html);
  });
});

describe('renderMarkdown: performance', () => {
  it('renders 20 KB in at most 5 ms', () => {
    const block = [
      '## Section with `code` and **bold** text',
      '',
      'A paragraph that mentions src/core/util/text.ts:42 and Assets/Scripts/Player.cs#L10, with *emphasis*,',
      'a [link](https://example.com/docs) and some_snake_case_identifiers that must stay intact.',
      '',
      '- item one with `inline code`',
      '  - nested item referencing lib/x.py:3-9',
      '- item two',
      '',
      '```ts',
      'export function add(a: number, b: number): number {',
      '  return a + b; // <not html>',
      '}',
      '```',
      '',
      '| Col A | Col B |',
      '|---|---|',
      '| 1 | **2** |',
      '',
    ].join('\n');
    let doc = '';
    while (doc.length < 20_000) doc += `${block}\n`;
    doc = doc.slice(0, 20_480);
    for (let i = 0; i < 10; i++) renderMarkdown(doc); // warm up the JIT
    const times: number[] = [];
    for (let i = 0; i < 21; i++) {
      const t0 = performance.now();
      renderMarkdown(doc);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    const median = times[Math.floor(times.length / 2)];
    expect(median).toBeLessThanOrEqual(5);
  });
});
