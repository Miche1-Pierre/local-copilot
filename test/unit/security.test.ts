import { describe, expect, it } from 'vitest';
import { analyzeStatic, formatFindingsForPrompt, severityRank } from '../../src/core/security/analyzer';
import { SECURITY_RULES } from '../../src/core/security/rules';
import { computeFunctionTaint, findTaintedVariable, parseParameters } from '../../src/core/security/taint';

const ids = (text: string, lang: string) => analyzeStatic(text, lang).map((f) => f.ruleId);

describe('rule set', () => {
  it('has unique ids, CWE tags and advice', () => {
    const seen = new Set<string>();
    for (const r of SECURITY_RULES) {
      expect(seen.has(r.id), r.id).toBe(false);
      seen.add(r.id);
      expect(r.cwe).toMatch(/^CWE-\d+$/);
      expect(r.message.length).toBeGreaterThan(10);
      expect(r.recommendation.length).toBeGreaterThan(10);
      expect(r.pattern.global).toBe(false);
    }
    expect(SECURITY_RULES.length).toBeGreaterThanOrEqual(40);
  });
});

describe('SQL injection', () => {
  it('Python: f-strings, % and + are flagged, parameters are not', () => {
    expect(ids('cursor.execute(f"SELECT * FROM t WHERE n = \'{name}\'")', 'python')).toContain('sql-injection-python');
    expect(ids('cur.execute("SELECT * FROM t WHERE n = %s" % name)', 'python')).toContain('sql-injection-python');
    expect(ids('cur.execute("SELECT * FROM t WHERE n = " + name)', 'python')).toContain('sql-injection-python');
    expect(ids('cur.execute("SELECT * FROM t WHERE n = ?", (name,))', 'python')).toEqual([]);
  });

  it('JS, C#, Java, PHP, Go', () => {
    expect(ids('db.query(`SELECT * FROM t WHERE id = ${id}`)', 'typescript')).toContain('sql-injection-js');
    expect(ids("db.query('SELECT * FROM t WHERE id = $1', [id])", 'typescript')).toEqual([]);
    expect(ids('var cmd = new SqlCommand("SELECT * FROM t WHERE n = \'" + name + "\'", conn);', 'csharp')).toContain('sql-injection-csharp');
    expect(ids('var cmd = new SqlCommand($"SELECT * FROM t WHERE n = \'{name}\'", conn);', 'csharp')).toContain('sql-injection-csharp');
    expect(ids('var cmd = new SqlCommand("SELECT * FROM t WHERE n = @n", conn);', 'csharp')).toEqual([]);
    expect(ids('ResultSet rs = st.executeQuery("SELECT * FROM t WHERE id = " + id);', 'java')).toContain('sql-injection-jvm');
    expect(ids('$r = $db->query("SELECT * FROM t WHERE id = " . $_GET["id"]);', 'php')).toContain('sql-injection-php');
    expect(ids('rows, _ := db.Query(fmt.Sprintf("SELECT * FROM t WHERE id = %s", id))', 'go')).toContain('sql-injection-go');
  });
});

describe('command and code injection', () => {
  it('flags shells and eval, not look-alikes', () => {
    expect(ids('os.system("rm -rf " + path)', 'python')).toContain('command-injection-python');
    expect(ids('subprocess.run(cmd, shell=True)', 'python')).toContain('subprocess-shell-true');
    expect(ids('subprocess.run(["ls", path])', 'python')).toEqual([]);
    expect(ids('child_process.exec(`git log ${branch}`)', 'javascript')).toContain('command-injection-js');
    expect(ids('const m = pattern.exec(text);', 'javascript')).toEqual([]);
    expect(ids('Process.Start("cmd.exe", "/c " + userArg);', 'csharp')).toContain('command-injection-csharp');
    expect(ids('Runtime.getRuntime().exec(cmd);', 'java')).toContain('command-injection-jvm');
    expect(ids('ResultSet r = s.executeQuery(q);', 'java')).not.toContain('command-injection-jvm');
    expect(ids('exec.Command("sh", "-c", input)', 'go')).toContain('command-injection-go');
    expect(ids('result = eval(expr)', 'python')).toContain('code-injection-python');
    expect(ids('value = ast.literal_eval(expr)', 'python')).toEqual([]);
    expect(ids('const r = retrieval(x); const v = eval(code);', 'javascript')).toEqual(['code-injection-js']);
    expect(ids('setTimeout("doIt()", 100);', 'javascript')).toContain('code-injection-js');
    expect(ids('setTimeout(() => doIt(), 100);', 'javascript')).toEqual([]);
  });
});

describe('deserialization, crypto, TLS', () => {
  it('flags unsafe loaders but not the safe ones', () => {
    expect(ids('data = pickle.loads(blob)', 'python')).toContain('deserialization-python');
    expect(ids('cfg = yaml.load(f)', 'python')).toContain('yaml-unsafe-load');
    expect(ids('cfg = yaml.load(f, Loader=yaml.SafeLoader)', 'python')).toEqual([]);
    expect(ids('cfg = yaml.safe_load(f)', 'python')).toEqual([]);
    expect(ids('var bf = new BinaryFormatter();', 'csharp')).toContain('deserialization-csharp');
    expect(ids('settings.TypeNameHandling = TypeNameHandling.All;', 'csharp')).toContain('deserialization-csharp');
  });

  it('flags weak algorithms but not SHA-256', () => {
    expect(ids('h = hashlib.md5(data).hexdigest()', 'python')).toContain('weak-hash');
    expect(ids('h = hashlib.sha256(data).hexdigest()', 'python')).toEqual([]);
    expect(ids('using var md5 = MD5.Create();', 'csharp')).toContain('weak-hash');
    expect(ids('MessageDigest md = MessageDigest.getInstance("SHA-1");', 'java')).toContain('weak-hash');
    expect(ids('aes.Mode = CipherMode.ECB;', 'csharp')).toContain('weak-cipher');
    expect(ids('Cipher c = Cipher.getInstance("AES/GCM/NoPadding");', 'java')).toEqual([]);
  });

  it('flags predictable randomness only for secrets', () => {
    expect(ids('string token = new Random().Next().ToString();', 'csharp')).toContain('insecure-random');
    expect(ids('float x = Random.Range(0f, 1f);', 'csharp')).toEqual([]);
    expect(ids('const resetToken = Math.random().toString(36);', 'javascript')).toContain('insecure-random');
  });

  it('flags disabled certificate checks', () => {
    expect(ids('r = requests.get(url, verify=False)', 'python')).toContain('tls-verification-disabled');
    expect(ids('const agent = new https.Agent({ rejectUnauthorized: false });', 'typescript')).toContain('tls-verification-disabled');
    expect(ids('handler.ServerCertificateCustomValidationCallback = (m, c, ch, e) => true;', 'csharp')).toContain('tls-verification-disabled');
    expect(ids('protected override bool ValidateCertificate(byte[] certificateData) { return true; }', 'csharp')).toContain('tls-verification-disabled');
  });
});

describe('secrets', () => {
  it('finds real-looking credentials', () => {
    // Fake secrets are assembled at runtime so repository secret scanners do not flag the test file.
    expect(ids(`aws_key = "${'AKIA'}${'IOSFODNN7EXAMPLE'}"`, 'python')).toContain('secret-token');
    expect(ids('const token = "ghp_' + 'a'.repeat(36) + '";', 'javascript')).toContain('secret-token');
    expect(ids(`-----BEGIN RSA ${'PRIVATE'} KEY-----`, 'plaintext')).toContain('private-key');
    expect(ids('db_password = "S3cr3t!Pa55"', 'python')).toContain('hardcoded-secret');
    expect(ids('private const string ApiKey = "9f8e7d6c5b4a3210";', 'csharp')).toContain('hardcoded-secret');
  });

  it('ignores placeholders, environment lookups and comments', () => {
    expect(ids('password = "changeme123"', 'python')).toEqual([]);
    expect(ids('password = os.environ["DB_PASSWORD"]', 'python')).toEqual([]);
    expect(ids('api_key = "<your-api-key-here>"', 'python')).toEqual([]);
    expect(ids('# password = "S3cr3t!Pa55"', 'python')).toEqual([]);
    expect(ids('// const secret = "abcdefghijkl";', 'javascript')).toEqual([]);
    expect(ids('placeholder.text = "Enter your password";', 'csharp')).toEqual([]);
  });

  it('flags secrets in PlayerPrefs', () => {
    expect(ids('PlayerPrefs.SetString("auth_token", token);', 'csharp')).toContain('playerprefs-secret');
    expect(ids('PlayerPrefs.SetString("volume", v);', 'csharp')).toEqual([]);
  });
});

describe('XSS, paths, misc', () => {
  it('XSS sinks', () => {
    expect(ids('el.innerHTML = comment.body;', 'javascript')).toContain('xss-dom');
    expect(ids("el.innerHTML = '';", 'javascript')).toEqual([]);
    expect(ids('el.innerHTML = DOMPurify.sanitize(html);', 'javascript')).toEqual([]);
    expect(ids('if (a === b) { x = 1; }', 'javascript')).toEqual([]);
    expect(ids('return render_template_string(mark_safe(user_html))', 'python')).toContain('xss-template');
    expect(ids('if (a || safe) run();', 'javascript')).toEqual([]);
  });

  it('path traversal and C memory safety', () => {
    expect(ids('with open(BASE + filename) as f:', 'python')).toContain('path-traversal-python');
    expect(ids('with open("config.json") as f:', 'python')).toEqual([]);
    expect(ids('var txt = File.ReadAllText(Application.dataPath + path);', 'csharp')).toContain('path-traversal-csharp');
    expect(ids('File.AppendAllText(path, stamped + "\\n");', 'csharp')).toEqual([]);
    expect(ids('fs.writeFileSync(outFile, header + body);', 'javascript')).toEqual([]);
    expect(ids('fs.readFileSync(dir + "/" + name);', 'javascript')).toContain('path-traversal-js');
    expect(ids('char buf[16]; gets(buf);', 'c')).toContain('c-gets');
    expect(ids('fgets(buf, sizeof buf, stdin);', 'c')).toEqual([]);
    expect(ids('strcpy(dst, src);', 'cpp')).toContain('c-unbounded-copy');
  });

  it('does not match inside strings for code rules', () => {
    expect(ids('print("never call os.system( with user data")', 'python')).toEqual([]);
  });
});

describe('taint', () => {
  it('parses parameters across languages', () => {
    expect(parseParameters('public void Load(string path, [FromQuery] int count = 3, ref Vector3 pos)', 'csharp')).toEqual(['path', 'count', 'pos']);
    expect(parseParameters('def find(self, name: str, *args, limit=10, **kw)', 'python')).toEqual(['name', 'args', 'limit', 'kw']);
    expect(parseParameters('export async function get(req: Request, { id, page }: Params, ...rest: string[])', 'typescript')).toEqual(['req', 'id', 'page', 'rest']);
    expect(parseParameters('func (s *Server) Handle(w http.ResponseWriter, r *http.Request)', 'go')).toEqual(['w', 'r']);
    expect(parseParameters('fn read(&self, path: &str, mut buf: Vec<u8>)', 'rust')).toEqual(['path', 'buf']);
    expect(parseParameters('function show(string $name, int $id = 0)', 'php')).toEqual(['name', 'id']);
    expect(parseParameters('fun load(path: String, retries: Int = 3)', 'kotlin')).toEqual(['path', 'retries']);
    expect(parseParameters('public List<User> find(@RequestParam String name, int page)', 'java')).toEqual(['name', 'page']);
  });

  it('propagates through assignments and prefers user input', () => {
    const src = ['def handler():', '    raw = request.args.get("q")', '    query = "SELECT " + raw', '    other = 1'].join('\n');
    const t = computeFunctionTaint(src, 'python', 0, 3, 'def handler()', 'handler');
    expect(t.tainted.get('raw')).toBe('user-input');
    expect(t.tainted.get('query')).toBe('user-input');
    expect(t.tainted.has('other')).toBe(false);
    expect(findTaintedVariable('cur.execute(query)', t, 'python')).toEqual({ variable: 'query', source: 'user-input' });
  });

  it('raises confidence and severity when request data reaches a sink', () => {
    const src = [
      'from flask import request',
      '',
      '@app.route("/u")',
      'def user():',
      '    name = request.args.get("name")',
      '    cur.execute(f"SELECT * FROM users WHERE name = \'{name}\'")',
    ].join('\n');
    const [f] = analyzeStatic(src, 'python');
    expect(f.ruleId).toBe('sql-injection-python');
    expect(f.confidence).toBe('high');
    expect(f.severity).toBe('critical');
    expect(f.taint).toMatchObject({ source: 'user-input', variable: 'name', functionName: 'user' });
  });

  it('marks parameter-fed sinks as medium confidence', () => {
    const src = ['def find_user(name):', '    cur.execute(f"SELECT * FROM users WHERE name = \'{name}\'")'].join('\n');
    const [f] = analyzeStatic(src, 'python');
    expect(f.confidence).toBe('medium');
    expect(f.severity).toBe('high');
    expect(f.taint?.variable).toBe('name');
  });

  it('handles a Unity-style method with a path parameter', () => {
    const src = [
      'public class SaveSystem : MonoBehaviour',
      '{',
      '    public string Load(string path)',
      '    {',
      '        var txt = File.ReadAllText(Application.dataPath + path);',
      '        return txt;',
      '    }',
      '}',
    ].join('\n');
    const f = analyzeStatic(src, 'csharp').find((x) => x.ruleId === 'path-traversal-csharp')!;
    expect(f.taint).toMatchObject({ source: 'parameter', variable: 'path', functionName: 'Load' });
    expect(f.confidence).toBe('medium');
  });

  it('requiresTaint rules stay silent on constants', () => {
    expect(ids('var p = Path.Combine(Application.persistentDataPath, "save.json");', 'csharp')).toEqual([]);
    const src = ['public void Save(string slot)', '{', '    var p = Path.Combine(dir, slot);', '}'].join('\n');
    expect(ids(src, 'csharp')).toContain('path-combine-tainted');
  });
});

describe('analyzer', () => {
  it('respects ranges and sorts by line then severity', () => {
    const src = ['h = hashlib.md5(x)', 'eval(y)', 'k = hashlib.sha1(z)'].join('\n');
    expect(analyzeStatic(src, 'python', { startLine: 1, endLine: 2 }).map((f) => f.line)).toEqual([1, 2]);
    expect(severityRank('critical')).toBeGreaterThan(severityRank('low'));
  });

  it('formats findings for the model with 1-based lines', () => {
    const src = ['def f(cmd):', '    os.system(cmd)'].join('\n');
    const text = formatFindingsForPrompt(analyzeStatic(src, 'python'));
    expect(text).toMatch(/^\[S1\] line 2 · CWE-78 · OS command execution · severity high, confidence medium · `os\.system\(cmd\)` · data from a parameter `cmd`$/);
  });

  it('is fast on large files', () => {
    const chunk = ['def handler(req):', '    q = req.args.get("q")', '    cur.execute("SELECT " + q)', '    data = pickle.loads(blob)', '    print(q)', ''].join('\n');
    const big = Array.from({ length: 1700 }, () => chunk).join('\n');
    const t0 = performance.now();
    const findings = analyzeStatic(big, 'python');
    const ms = performance.now() - t0;
    expect(findings.length).toBeGreaterThan(3000);
    expect(ms).toBeLessThan(1500);
  });

  it('survives a pathological long line', () => {
    const line = `x = "${'a,'.repeat(5000)}"`;
    const t0 = performance.now();
    analyzeStatic(line, 'python');
    expect(performance.now() - t0).toBeLessThan(500);
  });
});
