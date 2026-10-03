import { describe, expect, it } from 'vitest';
import { extractSymbols, outlineOf, symbolAt, CALLABLE_KINDS } from '../../src/core/index/symbols';

const UNITY = `using UnityEngine;
using System.Collections;

namespace Game.Player
{
    /// <summary>Tracks the player's health.</summary>
    [RequireComponent(typeof(Rigidbody))]
    public class PlayerHealth : MonoBehaviour
    {
        [SerializeField] private int maxHealth = 100;
        [Header("Feedback")]
        public float flashTime = 0.2f;
        private int currentHealth;
        public event System.Action OnDeath;

        public bool IsDead => currentHealth <= 0;
        public int Current { get; private set; }

        void Start()
        {
            currentHealth = maxHealth;
            if (currentHealth > 0) { Debug.Log("ready {"); }
        }

        public void TakeDamage(int amount)
        {
            currentHealth -= amount;
            foreach (var x in new int[] { 1, 2 }) { }
            if (IsDead)
            {
                OnDeath?.Invoke();
            }
        }

        private IEnumerator Flash(
            float duration,
            Color color)
        {
            yield return new WaitForSeconds(duration);
        }

        public PlayerHealth(int start) { currentHealth = start; }
    }

    public interface IDamageable
    {
        void TakeDamage(int amount);
    }

    public enum Team { Red, Blue }
}
`;

describe('C# (Unity) symbols', () => {
  const symbols = extractSymbols(UNITY, 'csharp');
  const byName = (n: string) => symbols.filter((s) => s.name === n);

  it('finds namespace, class, interface and enum with correct ranges', () => {
    const cls = byName('PlayerHealth').find((s) => s.kind === 'class')!;
    expect(cls.container).toBe('Game.Player');
    expect(cls.declLine).toBe(7);
    expect(cls.startLine).toBe(5); // doc comment + attribute included
    expect(cls.doc).toBe("Tracks the player's health.");
    expect(UNITY.split('\n')[cls.endLine].trim()).toBe('}');
    expect(byName('IDamageable')[0].kind).toBe('interface');
    expect(byName('Team')[0].kind).toBe('enum');
    expect(byName('Game.Player')[0].kind).toBe('namespace');
  });

  it('finds methods with their bodies, including multi-line signatures', () => {
    const start = byName('Start')[0];
    expect(start.kind).toBe('method');
    expect(start.container).toBe('PlayerHealth');
    expect(UNITY.split('\n')[start.endLine].trim()).toBe('}');
    const take = byName('TakeDamage').find((s) => s.container === 'PlayerHealth')!;
    expect(take.signature).toBe('public void TakeDamage(int amount)');
    expect(take.endLine - take.declLine).toBe(8);
    const flash = byName('Flash')[0];
    expect(flash.signature).toBe('private IEnumerator Flash( float duration, Color color)');
  });

  it('finds fields, properties, events and constructors, not statements', () => {
    expect(byName('maxHealth')[0].kind).toBe('field');
    expect(byName('flashTime')[0].kind).toBe('field');
    expect(byName('OnDeath')[0].kind).toBe('field');
    expect(byName('IsDead')[0].kind).toBe('property');
    expect(byName('Current')[0].kind).toBe('property');
    expect(symbols.find((s) => s.kind === 'constructor')?.name).toBe('PlayerHealth');
    for (const bogus of ['if', 'foreach', 'Log', 'Invoke', 'WaitForSeconds']) expect(byName(bogus)).toHaveLength(0);
  });

  it('locates the enclosing method of a line', () => {
    const line = UNITY.split('\n').findIndex((l) => l.includes('currentHealth -= amount'));
    expect(symbolAt(symbols, line, CALLABLE_KINDS)?.name).toBe('TakeDamage');
  });

  it('produces a compact outline', () => {
    const outline = outlineOf(symbols);
    expect(outline).toContain('public class PlayerHealth : MonoBehaviour');
    expect(outline).toContain('    public void TakeDamage(int amount)');
  });
});

describe('Python symbols', () => {
  const src = `import os

MAX_RETRIES = 3

class Repo:
    """Stores users."""
    table: str = "users"

    def __init__(self, db):
        self.db = db

    @staticmethod
    def normalize(name):
        text = """
not code: def fake():
"""
        return name.strip()

async def fetch_all(repo, limit=10):
    """Fetch everything.

    More details."""
    return await repo.db.all(limit)
`;
  const symbols = extractSymbols(src, 'python');
  const get = (n: string) => symbols.find((s) => s.name === n)!;

  it('finds classes, methods, functions, fields and constants', () => {
    expect(get('MAX_RETRIES').kind).toBe('variable');
    expect(get('Repo').kind).toBe('class');
    expect(get('Repo').doc).toBe('Stores users.');
    expect(get('table').kind).toBe('field');
    expect(get('__init__').kind).toBe('constructor');
    expect(get('normalize').container).toBe('Repo');
    expect(get('fetch_all').kind).toBe('function');
    expect(get('fetch_all').signature).toBe('async def fetch_all(repo, limit=10)');
    expect(get('fetch_all').doc).toContain('Fetch everything.');
    expect(symbols.find((s) => s.name === 'fake')).toBeUndefined();
  });

  it('includes decorators and survives multi-line strings at column 0', () => {
    const lines = src.split('\n');
    const normalize = get('normalize');
    expect(lines[normalize.startLine].trim()).toBe('@staticmethod');
    expect(lines[normalize.endLine].trim()).toBe('return name.strip()');
    expect(lines[get('Repo').endLine].trim()).toBe('return name.strip()');
  });
});

describe('TypeScript symbols', () => {
  const src = `import { x } from './x';

export interface Options { a: number; }
export type Id = string | number;
export enum Mode { A, B }

export function createServer(opts: Options): void {
  const handler = () => { return 1; };
}

export const fetchUser = async (id: Id): Promise<void> => {
  if (id) { await x(id); }
};

export default class Service extends Base {
  private cache = new Map<string, number>();
  constructor(private readonly db: Db) { super(); }
  async load(id: string): Promise<number> {
    for (const k of this.cache.keys()) { }
    return 1;
  }
  get size(): number { return this.cache.size; }
}
`;
  const symbols = extractSymbols(src, 'typescript');
  const get = (n: string) => symbols.find((s) => s.name === n);

  it('finds declarations of every kind', () => {
    expect(get('Options')?.kind).toBe('interface');
    expect(get('Id')?.kind).toBe('type');
    expect(get('Mode')?.kind).toBe('enum');
    expect(get('createServer')?.kind).toBe('function');
    expect(get('fetchUser')?.kind).toBe('function');
    expect(get('Service')?.kind).toBe('class');
    expect(get('load')?.kind).toBe('method');
    expect(get('load')?.container).toBe('Service');
    expect(get('constructor')?.kind).toBe('constructor');
    expect(get('cache')?.kind).toBe('property');
    expect(get('size')?.kind).toBe('method');
  });

  it('ignores nested functions and statements', () => {
    expect(get('handler')).toBeUndefined();
    expect(get('for')).toBeUndefined();
    expect(get('if')).toBeUndefined();
  });
});

describe('Go, Rust, Java symbols', () => {
  it('Go: functions, methods with receivers, structs', () => {
    const src = 'package main\n\ntype Server struct {\n\tAddr string\n}\n\nfunc (s *Server) Start(port int) error {\n\treturn nil\n}\n\nfunc main() {\n}\n';
    const symbols = extractSymbols(src, 'go');
    expect(symbols.find((s) => s.name === 'Server')?.kind).toBe('struct');
    expect(symbols.find((s) => s.name === 'Addr')?.kind).toBe('field');
    const start = symbols.find((s) => s.name === 'Start')!;
    expect(start.kind).toBe('method');
    expect(start.container).toBe('Server');
    expect(symbols.find((s) => s.name === 'main')?.kind).toBe('function');
  });

  it('Rust: structs, impl blocks and methods', () => {
    const src = "pub struct Point { x: i32 }\n\nimpl Display for Point {\n    fn fmt(&self, f: &mut Formatter<'_>) -> Result {\n        write!(f, \"{}\", self.x)\n    }\n}\n\npub async fn run() {}\n";
    const symbols = extractSymbols(src, 'rust');
    expect(symbols.find((s) => s.name === 'Point' && s.kind === 'struct')).toBeDefined();
    expect(symbols.find((s) => s.kind === 'impl')?.name).toBe('Point');
    expect(symbols.find((s) => s.name === 'fmt')?.kind).toBe('method');
    expect(symbols.find((s) => s.name === 'run')?.kind).toBe('function');
  });

  it('Java: classes, annotated methods, constructors', () => {
    const src = 'public class UserService {\n  private final Repo repo;\n  public UserService(Repo repo) { this.repo = repo; }\n  @Override\n  public List<User> findAll() {\n    return repo.all();\n  }\n}\n';
    const symbols = extractSymbols(src, 'java');
    expect(symbols.find((s) => s.name === 'repo')?.kind).toBe('field');
    expect(symbols.find((s) => s.kind === 'constructor')?.name).toBe('UserService');
    const findAll = symbols.find((s) => s.name === 'findAll')!;
    expect(findAll.kind).toBe('method');
    expect(src.split('\n')[findAll.startLine].trim()).toBe('@Override');
  });
});

describe('Markdown sections', () => {
  it('turns headings into nested sections and ignores code fences', () => {
    const md = '# Game\nintro\n## Guard AI\ntext\n```python\n# not a heading\n```\n## Inventory\nmore\n# Next\n';
    const s = extractSymbols(md, 'markdown');
    expect(s.map((x) => x.name)).toEqual(['Game', 'Guard AI', 'Inventory', 'Next']);
    expect(s[1].container).toBe('Game');
    expect(s[1].endLine).toBe(6);
    expect(s[0].endLine).toBe(8);
  });
});
