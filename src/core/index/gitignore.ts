// .gitignore matching (the common subset: comments, negation, anchoring,
// directory-only patterns, *, **, ?, [...]). Paths are workspace-relative POSIX.

interface Rule {
  base: string;
  regex: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

export function globToRegExpSource(glob: string): string {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const slashAfter = glob[i + 2] === '/';
        re += slashAfter ? '(?:.*/)?' : '.*';
        i += slashAfter ? 2 : 1;
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '[') {
      const end = glob.indexOf(']', i + 1);
      if (end < 0) re += '\\[';
      else {
        re += `[${glob.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else if ('.+^${}()|\\'.includes(c)) re += `\\${c}`;
    else re += c;
  }
  return re;
}

export class IgnoreMatcher {
  private readonly rules: Rule[] = [];

  /** `base` is the directory holding the .gitignore ('' for the root). */
  add(base: string, content: string): void {
    for (const raw of content.split(/\r?\n/)) {
      let line = raw.replace(/\s+$/, '');
      if (!line || line.startsWith('#')) continue;
      let negate = false;
      if (line.startsWith('!')) {
        negate = true;
        line = line.slice(1);
      }
      if (line.startsWith('\\')) line = line.slice(1);
      const dirOnly = line.endsWith('/');
      if (dirOnly) line = line.slice(0, -1);
      const anchored = line.includes('/');
      if (line.startsWith('/')) line = line.slice(1);
      const body = globToRegExpSource(line);
      const regex = new RegExp(anchored ? `^${body}(?:/.*)?$` : `(?:^|/)${body}(?:/.*)?$`);
      this.rules.push({ base, regex, negate, dirOnly });
    }
  }

  /** `isDir` tells whether `path` itself is a directory. */
  ignores(path: string, isDir = false): boolean {
    let ignored = false;
    for (const rule of this.rules) {
      if (rule.base && !path.startsWith(`${rule.base}/`)) continue;
      const rel = rule.base ? path.slice(rule.base.length + 1) : path;
      if (!rule.regex.test(rel)) continue;
      // A dir-only rule matches a file only through one of its parent directories.
      if (rule.dirOnly && !isDir && !this.matchesParentDir(rule, rel)) continue;
      ignored = !rule.negate;
    }
    return ignored;
  }

  private matchesParentDir(rule: Rule, rel: string): boolean {
    const segs = rel.split('/');
    for (let n = 1; n < segs.length; n++) {
      if (rule.regex.test(segs.slice(0, n).join('/'))) return true;
    }
    return false;
  }
}
