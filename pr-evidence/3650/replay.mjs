import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

assert.ok(['darwin', 'linux'].includes(process.platform),
  'Replay requires macOS/Linux HOME isolation; Windows user directories are not redirected by this harness.');
const root = process.cwd();
const work = process.env.EVIDENCE_WORK ?? path.join(root, 'work/rtk-3650');
const output = process.env.EVIDENCE_OUTPUT ?? path.join(root, 'outputs/RTK-3650');
const binaries = {
  before: process.env.RTK_BEFORE ?? path.join(work, 'rtk-before'),
  after: process.env.RTK_AFTER ?? path.join(work, 'rtk-after'),
};
fs.mkdirSync(work, { recursive: true });
const scratch = fs.mkdtempSync(path.join(work, 'discover-fixture-'));
const project = path.join(scratch, 'project');
const home = path.join(scratch, 'home');
const claude = path.join(home, '.claude');
for (const dir of [project, path.join(project, '.claude'), claude, output,
  path.join(claude, 'projects', 'controlled-fixture')]) fs.mkdirSync(dir, { recursive: true });
const env = {
  PATH: '/usr/bin:/bin', HOME: home, CLAUDE_CONFIG_DIR: claude,
  XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DATA_HOME: path.join(home, '.local/share'),
  RTK_DB_PATH: path.join(scratch, 'tracking.db'),
  RTK_TELEMETRY_DISABLED: '1', RTK_SUPPRESS_HOOK_WARNING: '1',
  RTK_TEE: '0', RTK_RECALL: '0', LC_ALL: 'C',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(scratch, 'empty-gitconfig'),
};
function config(installed, permissions, excluded = []) {
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({
    hooks: installed ? { PreToolUse: [{ matcher: 'Bash',
      hooks: [{ type: 'command', command: 'rtk hook claude' }] }] } : {},
    permissions,
  }, null, 2));
  const toml = `[telemetry]\nenabled = false\nconsent_given = false\n[hooks]\nexclude_commands = ${JSON.stringify(excluded)}\n`;
  for (const dir of [path.join(home, '.config/rtk'), path.join(home, 'Library/Application Support/rtk')]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.toml'), toml);
  }
}
const sessionFile = path.join(claude, 'projects/controlled-fixture/session.jsonl');
function transcript(commands) {
  const lines = [];
  commands.forEach((command, i) => {
    const id = `fixture-${i}`;
    lines.push(JSON.stringify({ type: 'assistant', message: { role: 'assistant',
      content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }));
    lines.push(JSON.stringify({ type: 'user', message: { role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id,
        content: 'Controlled transcript output; no command was executed.' }] } }));
  });
  fs.writeFileSync(sessionFile, lines.join('\n') + '\n');
}
function run(variant, args) {
  const start = performance.now();
  const result = spawnSync(binaries[variant], args, {
    cwd: project, env, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return { exit: result.status, stdout: result.stdout, stderr: result.stderr,
    milliseconds: Number((performance.now() - start).toFixed(3)) };
}
const scenarios = [
  ['default', true, {}, 'git status'],
  ['allow', true, { allow: ['Bash(git *)'] }, 'git status'],
  ['ask', true, { ask: ['Bash(git *)'] }, 'git status'],
  ['deny', true, { deny: ['Bash(git *)'] }, 'git status'],
  ['substitution', true, { allow: ['Bash(*)'] }, 'git status $(printf x)'],
  ['file-redirect', true, { allow: ['Bash(*)'] }, 'git status > never-written'],
  ['discarded-output', true, {}, 'git status > /dev/null'],
  ['wrapper-ask', true, {}, "bash -c 'git status'"],
  ['wrapper-with-substitution', true, {}, "bash -c 'git status' $(printf x)"],
  ['wrapper-with-redirect', true, {}, "bash -c 'git status' > never-written"],
  ['wrapper-defer', true, { deny: ['Bash(git push)'] }, "bash -c 'git push'"],
  ['prefixed-wrapper-defer', true, { deny: ['Bash(git push)'] }, "env bash -c 'git push'"],
  ['wrapper-sibling', true, {}, "bash -c 'printf x' && git status"],
  ['wrapper-redirect-sibling', true, {}, "bash -c 'printf x' > never-written && git status"],
  ['wrapper-substitution-sibling', true, {}, "bash -c 'printf x' $(printf x) && git status"],
  ['chain-deny', true, { deny: ['Bash(cd /sensitive)'] }, 'cd /sensitive && git status'],
  ['bypass', true, {}, 'RTK_DISABLED=1 git status'],
  ['bypass-denied', true, { deny: ['Bash(RTK_DISABLED=1 git status)'] }, 'RTK_DISABLED=1 git status'],
  ['excluded', true, {}, 'git status', ['git']],
  ['no-hook', false, {}, 'git status'],
];
const records = [];
const demo = process.argv.find(arg => arg.startsWith('--demo='))?.slice('--demo='.length);
if (demo) {
  assert.ok(demo === 'before' || demo === 'after');
  config(true, {});
  const count = 20000;
  transcript(Array(count).fill('git status'));
  const result = run(demo, ['discover', '--all', '--format', 'json']);
  assert.equal(result.exit, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.sessions_scanned, 1);
  assert.equal(report.total_commands, count);
  assert.equal(report.already_rtk_estimated, count);
  console.log(JSON.stringify({
    variant: demo, command: 'rtk discover --all --format json',
    fixture: '20,000 controlled stored Bash requests, not executed',
    exit: result.exit, milliseconds: result.milliseconds, report,
    reportHash: crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex'),
  }, null, 2));
  process.exit(0);
}
for (const [name, installed, permissions, command, excluded = []] of scenarios) {
  config(installed, permissions, excluded);
  transcript([command]);
  const before = run('before', ['discover', '--all', '--format', 'json']);
  const after = run('after', ['discover', '--all', '--format', 'json']);
  assert.equal(before.exit, 0, `${name}: ${before.stderr}`);
  assert.equal(after.exit, 0, `${name}: ${after.stderr}`);
  const original = JSON.parse(before.stdout);
  const fixed = JSON.parse(after.stdout);
  assert.equal(original.sessions_scanned, 1);
  assert.ok(original.total_commands >= 1);
  assert.deepEqual(fixed, original, `discover report changed in ${name}`);
  if (name === 'wrapper-sibling') assert.equal(fixed.already_rtk_estimated, 1);
  if (name === 'wrapper-redirect-sibling' || name === 'wrapper-substitution-sibling') {
    assert.equal(fixed.already_rtk_estimated, 0);
  }
  const oldRewrite = run('before', ['rewrite', command]);
  const newRewrite = run('after', ['rewrite', command]);
  assert.equal(newRewrite.exit, oldRewrite.exit, `rewrite exit changed in ${name}`);
  assert.equal(newRewrite.stdout, oldRewrite.stdout, `rewrite output changed in ${name}`);
  records.push({ name, command, installed, permissions, excluded, discoverEqual: true,
    rewriteEqual: true, rewriteExit: newRewrite.exit, report: fixed });
}
config(true, {});
const count = Number(process.env.DISCOVER_COMMANDS ?? 20000);
assert.ok(Number.isInteger(count) && count > 0 && count <= 100000);
transcript(Array(count).fill('git status'));
const samples = [];
// Warm both binaries and their shared fixture/database caches, then alternate
// order. This is a local debug-build timing observation, not a release benchmark.
for (const variant of ['before', 'after']) {
  const warm = run(variant, ['discover', '--all', '--format', 'json']);
  assert.equal(warm.exit, 0, warm.stderr);
  assert.equal(JSON.parse(warm.stdout).already_rtk_estimated, count);
}
for (let round = 0; round < 5; round++) {
  for (const variant of round % 2 ? ['after', 'before'] : ['before', 'after']) {
    const result = run(variant, ['discover', '--all', '--format', 'json']);
    assert.equal(result.exit, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.total_commands, count);
    assert.equal(report.already_rtk_estimated, count);
    samples.push({ round, variant, milliseconds: result.milliseconds });
  }
}
const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
const report = {
  capturedAt: new Date().toISOString(),
  environment: `${os.type()} ${os.release()} ${os.arch()}; native debug RTK binaries`,
  boundary: 'Isolated synthetic Claude transcript; transcript commands are data, never executed. Telemetry disabled; no user credentials or real agent sessions.',
  baselineCommit: 'e542dca0bdcc262fa035dcf7fc33910cdcc8cdaf',
  binaryHashes: Object.fromEntries(Object.entries(binaries).map(([variant, file]) =>
    [variant, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])),
  assertions: `${records.length} discover reports and rewrite outputs/exits exactly preserved`,
  scenarios: records,
  timing: { commands: count, samples,
    medianBeforeMs: median(samples.filter(s => s.variant === 'before').map(s => s.milliseconds)),
    medianAfterMs: median(samples.filter(s => s.variant === 'after').map(s => s.milliseconds)),
    caveat: 'Local debug-build observation only; do not extrapolate to release/production or claim a 50% whole-command speedup.' },
};
const serialized = JSON.stringify(report, null, 2) + '\n';
fs.writeFileSync(path.join(output, 'native-comparison.json'), serialized);
fs.mkdirSync(path.join(output, 'runs'), { recursive: true });
fs.writeFileSync(path.join(output, 'runs', `${Date.now()}.json`), serialized);
console.log(JSON.stringify({ assertions: report.assertions, timing: report.timing }, null, 2));
