import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const work = process.env.EVIDENCE_WORK ?? path.join(root, 'work/rtk-4543');
const output = process.env.EVIDENCE_OUTPUT ?? path.join(root, 'outputs/RTK-4543');
const repo = process.env.RTK_REPO ?? path.join(root, 'work/repos/rtk-4614-baseline');
const semgrep = process.env.SEMGREP_BIN ?? path.join(root, 'work/toolchains/semgrep/bin/semgrep');
const baseCommit = 'e542dca0bdcc262fa035dcf7fc33910cdcc8cdaf';
const home = path.join(work, 'scanner-home');
for (const dir of [work, output, home, path.join(work, 'logs')]) fs.mkdirSync(dir, { recursive: true });
const env = {
  PATH: `${path.dirname(semgrep)}:/usr/bin:/bin:/opt/homebrew/bin`,
  HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'),
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(home, 'empty-gitconfig'),
  GIT_TEMPLATE_DIR: path.join(home, 'empty-template'), LC_ALL: 'C',
  SEMGREP_SETTINGS_FILE: path.join(home, 'settings.yml'),
  SEMGREP_SEND_METRICS: 'off', SEMGREP_ENABLE_VERSION_CHECK: '0',
};
fs.mkdirSync(env.GIT_TEMPLATE_DIR, { recursive: true });

function command(program, args, cwd) {
  const result = spawnSync(program, args, {
    cwd, env, encoding: 'utf8', timeout: 60000, maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return result;
}

function git(args, cwd) {
  const result = command('git', args, cwd);
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

const original = git(['show', `${baseCommit}:.github/workflows/ci.yml`], repo);
const fixed = fs.readFileSync(path.join(repo, '.github/workflows/ci.yml'), 'utf8');
function commands(workflow) {
  const scans = workflow.split('\n').map(line =>
    line.trim().match(/^- run: semgrep scan (.+)$/)?.[1]).filter(Boolean);
  assert.equal(scans.length, 2);
  return scans;
}
const workflows = { before: commands(original), after: commands(fixed) };
const version = command(semgrep, ['--version'], work);
assert.equal(version.status, 0, version.stderr);

if (process.argv.includes('--real-diff')) {
  assert.equal(git(['status', '--porcelain'], repo), '', 'actual branch must be committed and clean');
  const scans = [];
  for (const source of workflows.after) {
    const args = ['scan', ...source.replace(/ \|\| true$/, '').split(/\s+/),
      '--json', '--metrics=off', '--disable-version-check'];
    const result = command(semgrep, args, repo);
    const parsed = JSON.parse(result.stdout);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(parsed.errors.length, 0, JSON.stringify(parsed.errors));
    assert.equal(parsed.results.length, 0, JSON.stringify(parsed.results));
    scans.push({ command: ['semgrep', ...args].join(' '), exit: result.status, findings: parsed.results.length });
  }
  const report = { capturedAt: new Date().toISOString(), commit: git(['rev-parse', 'HEAD'], repo),
    parent: git(['rev-parse', 'HEAD^1'], repo), scans };
  fs.writeFileSync(path.join(output, 'actual-branch-scan.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exit(0);
}

function fixture(scenario) {
  const dir = fs.mkdtempSync(path.join(work, 'merge-fixture-'));
  fs.copyFileSync(path.join(repo, '.semgrep.yml'), path.join(dir, '.semgrep.yml'));
  git(['init', '-q', '-b', 'main'], dir);
  git(['config', 'user.name', 'RTK fixture'], dir);
  git(['config', 'user.email', 'fixture@example.invalid'], dir);
  git(['add', '.semgrep.yml'], dir);
  git(['commit', '-q', '-m', 'initial rule set'], dir);
  const eventBase = git(['rev-parse', 'HEAD'], dir);
  git(['switch', '-q', '-c', 'feature'], dir);
  fs.writeFileSync(path.join(dir, 'pr.rs'), scenario === 'inherited-only'
    ? 'fn ordinary_pr_change() {}\n'
    : 'use std::process::Command;\nfn new_pr_finding() {\n Command::new("bash");\n let _ = std::fs::remove_file("pr-owned");\n}\n');
  git(['add', 'pr.rs'], dir);
  git(['commit', '-q', '-m', 'PR change'], dir);
  git(['switch', '-q', '-c', 'base', eventBase], dir);
  fs.writeFileSync(path.join(dir, 'base.rs'),
    'use std::process::Command;\nfn inherited_base_finding() {\n Command::new("sh");\n let _ = std::fs::remove_file("base-owned");\n}\n');
  git(['add', 'base.rs'], dir);
  git(['commit', '-q', '-m', 'base advanced'], dir);
  const mergeBase = git(['rev-parse', 'HEAD'], dir);
  git(['merge', '-q', '--no-ff', '--no-edit', 'feature'], dir);
  return { dir, eventBase, mergeBase, merge: git(['rev-parse', 'HEAD'], dir) };
}

function scan(variant, scenario, severity, graph) {
  const source = workflows[variant].find(line => line.includes(`--severity ${severity}`));
  assert.ok(source);
  const rendered = source.replace('${{ github.event.pull_request.base.sha }}', graph.eventBase);
  const args = ['scan', ...rendered.replace(/ \|\| true$/, '').split(/\s+/),
    '--json', '--metrics=off', '--disable-version-check'];
  const result = command(semgrep, args, graph.dir);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.errors.length, 0, JSON.stringify(parsed.errors));
  const findings = parsed.results.map(finding => ({
    rule: finding.check_id, path: finding.path,
    line: finding.start.line, severity: finding.extra.severity,
  })).sort((a, b) => a.path.localeCompare(b.path));
  const expectedPaths = variant === 'before' ? ['base.rs'] : [];
  if (scenario === 'new-pr-finding') expectedPaths.push('pr.rs');
  assert.deepEqual(findings.map(f => f.path), expectedPaths);
  const expectedExit = severity === 'ERROR' && findings.length > 0 ? 1 : 0;
  assert.equal(result.status, expectedExit, result.stderr);
  const baseline = args[args.indexOf('--baseline-commit') + 1];
  const record = {
    variant, scenario, severity, command: ['semgrep', ...args].join(' '),
    baselineExpression: baseline, resolvedBaseline: git(['rev-parse', baseline], graph.dir),
    mergeBase: graph.mergeBase, eventBase: graph.eventBase, scannedMerge: graph.merge,
    exit: result.status, findings,
    baselineMatchesScannedBase: git(['rev-parse', baseline], graph.dir) === graph.mergeBase,
  };
  fs.writeFileSync(path.join(work, 'logs', `${variant}-${scenario}-${severity}.json`), result.stdout);
  fs.writeFileSync(path.join(work, 'logs', `${variant}-${scenario}-${severity}.stderr.txt`), result.stderr);
  return record;
}

const filterVariant = process.argv.find(a => a.startsWith('--variant='))?.split('=')[1];
const filterScenario = process.argv.find(a => a.startsWith('--scenario='))?.split('=')[1];
const filterSeverity = process.argv.find(a => a.startsWith('--severity='))?.split('=')[1];
const results = [];
for (const scenario of ['inherited-only', 'new-pr-finding']) {
  if (filterScenario && filterScenario !== scenario) continue;
  const graph = fixture(scenario);
  for (const severity of ['ERROR', 'WARNING']) {
    if (filterSeverity && filterSeverity !== severity) continue;
    for (const variant of ['before', 'after']) {
      if (!filterVariant || filterVariant === variant) results.push(scan(variant, scenario, severity, graph));
    }
  }
}
assert.ok(results.length > 0);
const report = {
  capturedAt: new Date().toISOString(),
  environment: `Native Semgrep ${version.stdout.trim()}, real repository rules, isolated synthetic Git PR merge; not a GitHub-hosted runner`,
  validation: `all ${results.length} scanner/fixture combinations passed exact finding and exit-code assertions`,
  results,
};
if (!filterVariant && !filterScenario && !filterSeverity) {
  fs.writeFileSync(path.join(output, 'scanner-comparison.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
