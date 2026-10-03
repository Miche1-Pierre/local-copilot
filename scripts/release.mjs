#!/usr/bin/env node
// One-command release: checks → version bump → changelog → .vsix → dev merged
// into main → tag → push → GitHub release with the .vsix attached.
//
//   npm run release -- patch|minor|major|X.Y.Z [--dry-run]
//
// Run it from a clean `dev` branch. Needs git and the GitHub CLI (gh auth login).
import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [bump, ...flags] = process.argv.slice(2);
const dryRun = flags.includes('--dry-run');
const win = process.platform === 'win32';

function fail(message) {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function run(cmd, args, { quiet = false } = {}) {
  // npm is a .cmd shim on Windows and needs a shell; git and gh are real executables.
  const shell = win && cmd === 'npm';
  const out = execFileSync(cmd, args, { encoding: 'utf8', shell, stdio: quiet ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'inherit'] });
  return out.trim();
}

const git = (...args) => run('git', args, { quiet: true });

function nextVersion(current, kind) {
  if (/^\d+\.\d+\.\d+$/.test(kind)) return kind;
  const [major, minor, patch] = current.split('.').map(Number);
  if (kind === 'major') return `${major + 1}.0.0`;
  if (kind === 'minor') return `${major}.${minor + 1}.0`;
  if (kind === 'patch') return `${major}.${minor}.${patch + 1}`;
  return fail('Usage: npm run release -- <patch|minor|major|X.Y.Z> [--dry-run]');
}

function step(title, action) {
  console.log(`\n▶ ${title}`);
  if (dryRun) return console.log('  (dry run: skipped)');
  return action();
}

// ---------------------------------------------------------------- preconditions
if (!bump) fail('Usage: npm run release -- <patch|minor|major|X.Y.Z> [--dry-run]');
if (git('rev-parse', '--abbrev-ref', 'HEAD') !== 'dev') fail('Releases start from the dev branch: git switch dev');
if (git('status', '--porcelain')) fail('The working tree is not clean: commit or stash first.');
try {
  run('gh', ['auth', 'status'], { quiet: true });
} catch {
  fail('GitHub CLI is not logged in: run gh auth login');
}
git('fetch', 'origin', '--tags');
if (git('rev-list', '--count', 'HEAD..origin/dev') !== '0') fail('dev is behind origin/dev: git pull first.');

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = nextVersion(pkg.version, bump);
const tag = `v${version}`;
if (git('tag', '--list', tag)) fail(`Tag ${tag} already exists.`);
function commitsSinceLastRelease() {
  try {
    const last = git('describe', '--tags', '--abbrev=0', 'origin/main');
    return git('log', '--no-merges', '--format=- %s', `${last}..HEAD`);
  } catch {
    return '';
  }
}

const changelog = readFileSync('CHANGELOG.md', 'utf8');
const unreleased = /## Unreleased\s*\n([\s\S]*?)(?=\n## |\s*$)/.exec(changelog)?.[1].trim() ?? '';
const notes = unreleased || commitsSinceLastRelease() || '- Maintenance release.';
console.log(`Releasing ${pkg.version} → ${version}${dryRun ? ' (dry run)' : ''}\n\nNotes:\n${notes}`);

// ---------------------------------------------------------------- release
step('Typecheck and unit tests', () => {
  run('npm', ['run', 'typecheck']);
  run('npm', ['test']);
});

step(`Bump version to ${version}`, () => run('npm', ['version', version, '--no-git-tag-version']));

step('Update CHANGELOG.md', () => {
  const date = new Date().toISOString().slice(0, 10);
  const updated = changelog.replace(/## Unreleased\s*\n[\s\S]*?(?=\n## |\s*$)/, `## Unreleased\n\n## ${version} — ${date}\n\n${notes}\n`);
  writeFileSync('CHANGELOG.md', updated.endsWith('\n') ? updated : `${updated}\n`);
});

const vsix = `dist/local-copilot-${version}.vsix`;
step(`Build ${vsix}`, () => {
  run('npm', ['run', 'package']);
  copyFileSync('dist/local-copilot.vsix', vsix);
});

step(`Commit and merge dev into main as ${tag}`, () => {
  git('add', 'package.json', 'package-lock.json', 'CHANGELOG.md');
  git('commit', '-m', `chore(release): ${tag}`);
  git('switch', 'main');
  git('merge', '--ff-only', 'origin/main');
  git('merge', '--no-ff', 'dev', '-m', `release: ${tag}`);
  git('tag', '-a', tag, '-m', `Local Copilot ${version}`);
  git('switch', 'dev');
  git('merge', '--ff-only', 'main');
});

step('Push main, dev and the tag', () => {
  git('push', 'origin', 'main', 'dev');
  git('push', 'origin', tag);
});

step('Publish the GitHub release', () => {
  const notesFile = join(mkdtempSync(join(tmpdir(), 'release-')), 'notes.md');
  writeFileSync(notesFile, `${notes}\n\n**Install:** download \`local-copilot-${version}.vsix\` below, then \`code --install-extension local-copilot-${version}.vsix\`.\n`);
  run('gh', ['release', 'create', tag, vsix, '--title', `Local Copilot ${version}`, '--notes-file', notesFile]);
});

console.log(`\n✓ ${tag} released${dryRun ? ' (dry run, nothing changed)' : ''}.`);
