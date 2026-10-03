import { describe, expect, it } from 'vitest';
import { CharKind, commentLines, maskCode, stripCommentMarkers } from '../../src/core/index/scanner';

describe('maskCode', () => {
  it('keeps length and newlines, blanks comments and string contents', () => {
    const src = 'var s = "a{b}"; // c { d\nint x = 1; /* { */';
    const { masked } = maskCode(src, 'csharp');
    expect(masked.length).toBe(src.length);
    expect(masked).toBe('var s = "    ";         \nint x = 1;        ');
  });

  it('handles C# verbatim, interpolated and raw strings', () => {
    const src = 'var a = @"C:\\dir\\""{x}"; var b = $"{{y}} {z}"; var c = """\n { raw }\n""";';
    const { masked } = maskCode(src, 'csharp');
    expect(masked).not.toContain('{x}');
    expect(masked).not.toContain('raw');
    expect(masked).toContain('var b =');
    expect(masked).toContain('var c =');
  });

  it('handles Python triple quotes and # comments', () => {
    const src = 'def f():\n    """doc { not code }"""\n    return "#notcomment"  # real comment\n';
    const { masked, kinds } = maskCode(src, 'python');
    expect(masked).not.toContain('not code');
    expect(masked).not.toContain('real comment');
    expect(masked).toContain('return "');
    expect(kinds[src.indexOf('#notcomment')]).toBe(CharKind.StringContent);
  });

  it('handles JS template literals with nested expressions', () => {
    const src = 'const t = `a ${ obj.map(x => { return x; }) } b {`; function f() {}';
    const { masked } = maskCode(src, 'typescript');
    expect(masked).toContain('obj.map(x => { return x; })');
    expect(masked).not.toContain(' b {');
    expect(masked).toContain('function f() {}');
  });

  it('recognises JS regex literals but not divisions', () => {
    const src = 'const r = /["{]/g; const d = a / b / c;';
    const { masked } = maskCode(src, 'javascript');
    expect(masked).not.toContain('["{]');
    expect(masked).toContain('a / b / c');
  });

  it('does not treat Rust lifetimes as char literals', () => {
    const src = "fn f<'a>(x: &'a str) -> char { 'x' }";
    const { masked } = maskCode(src, 'rust');
    expect(masked).toContain("fn f<'a>(x: &'a str) -> char {");
    expect(masked).not.toContain("'x'".replace(/'/g, '') + "'");
  });

  it('does not let an unterminated quote swallow the file', () => {
    const src = 'int a = 1; // it\'s fine\nchar c = \'x\';\nvoid F() { }';
    const { masked } = maskCode(src, 'csharp');
    expect(masked).toContain('void F() { }');
  });

  it('supports nested block comments where the language does', () => {
    const src = '/* a /* b */ c */ fn main() {}';
    expect(maskCode(src, 'rust').masked).toContain('fn main() {}');
    expect(maskCode(src, 'rust').masked).not.toContain(' c ');
  });

  it('handles Lua long strings and comments', () => {
    const src = 'local s = [[ { ]] --[[ block { ]] -- line {\nfunction f() end';
    const { masked } = maskCode(src, 'lua');
    expect(masked).not.toContain('{');
    expect(masked).toContain('function f() end');
  });
});

describe('commentLines', () => {
  it('returns comment text without markers and whether the line is comment-only', () => {
    const src = '// Review this for security\nint x = 1; // trailing\n/// <summary>Doc</summary>\n';
    const lines = commentLines(src, 'csharp');
    expect(lines).toEqual([
      { line: 0, text: 'Review this for security', fullLine: true },
      { line: 1, text: 'trailing', fullLine: false },
      { line: 2, text: '<summary>Doc</summary>', fullLine: true },
    ]);
  });

  it('strips markers of many languages', () => {
    expect(stripCommentMarkers('# hello')).toBe('hello');
    expect(stripCommentMarkers('-- hi')).toBe('hi');
    expect(stripCommentMarkers('/** doc */')).toBe('doc');
    expect(stripCommentMarkers(' * item')).toBe('item');
    expect(stripCommentMarkers('<!-- note -->')).toBe('note');
  });
});
