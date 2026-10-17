import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';

// This harness executes both real RTK binaries and the vendor's real oc CLI.
// Kubernetes responses are simulated locally, not a production-cluster test.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const work = process.env.RTK_EVIDENCE_WORK ?? path.join(root, 'work/rtk-4614');
const output = process.env.RTK_EVIDENCE_OUTPUT ?? path.join(root, 'outputs/RTK-4614');
const oc = process.env.OC_BIN ?? path.join(root, 'work/toolchains/oc/oc');
const binaries = {
  before: process.env.RTK_BEFORE ?? path.join(work, 'rtk-before'),
  after: process.env.RTK_AFTER ?? path.join(work, 'rtk-after'),
};
const pods = JSON.parse(fs.readFileSync(process.env.PODS_FIXTURE ?? path.join(root, 'work/repos/rtk/tests/fixtures/oc_pods.json')));
const requests = [];
let activeRun;
fs.mkdirSync(output, { recursive: true });

function json(res, data, code = 200) {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

function status(res, reason, message, code) {
  json(res, { kind: 'Status', apiVersion: 'v1', status: 'Failure', reason, message, code }, code);
}

function apiHandler(cluster) {
  return (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ run: activeRun, cluster, path: url.pathname, impersonateUser: req.headers['impersonate-user'] ?? null });
    if (cluster === 'default') return status(res, 'Forbidden', 'wrong cluster selected', 403);
    if (url.pathname === '/api') return json(res, { kind: 'APIVersions', apiVersion: 'v1', versions: ['v1'], serverAddressByClientCIDRs: [] });
    if (url.pathname === '/apis') return json(res, { kind: 'APIGroupList', apiVersion: 'v1', groups: [] });
    if (url.pathname === '/api/v1') return json(res, {
      kind: 'APIResourceList', apiVersion: 'v1', groupVersion: 'v1',
      resources: [
        { name: 'pods', singularName: 'pod', namespaced: true, kind: 'Pod', verbs: ['get', 'list'], shortNames: ['po'] },
        { name: 'services', singularName: 'service', namespaced: true, kind: 'Service', verbs: ['get', 'list'], shortNames: ['svc'] },
      ],
    });
    if (req.headers['impersonate-user'] === 'forbidden') return status(res, 'Forbidden', 'pods is forbidden for forbidden', 403);
    if (/\/pods\/api\/log$/.test(url.pathname)) {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('2026-10-18T00:00:00Z API ready\n2026-10-18T00:00:01Z Serving requests\n');
    }
    if (/\/pods\/api$/.test(url.pathname)) return json(res, {
      kind: 'Pod', apiVersion: 'v1',
      metadata: { name: 'api', namespace: 'staging' },
      spec: { containers: [{ name: 'app', image: 'demo:test' }] },
      status: { phase: 'Running' },
    });
    if (/\/pods$/.test(url.pathname)) {
      const namespace = /\/namespaces\/([^/]+)\//.exec(url.pathname)?.[1];
      return json(res, {
        ...pods, kind: 'PodList',
        items: pods.items.map(pod => ({
          ...pod, kind: 'Pod', apiVersion: 'v1',
          metadata: { ...pod.metadata, ...(namespace ? { namespace } : {}) },
        })),
      });
    }
    if (/\/services$/.test(url.pathname)) return json(res, {
      kind: 'ServiceList', apiVersion: 'v1', metadata: {},
      items: [{
        kind: 'Service', apiVersion: 'v1', metadata: { name: 'api', namespace: 'staging' },
        spec: { type: 'ClusterIP', clusterIP: '10.0.0.1', ports: [{ port: 80, targetPort: 8080 }] },
      }],
    });
    return status(res, 'NotFound', `local fixture has no route for ${url.pathname}`, 404);
  };
}

async function listen(server) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}
const selectedApi = http.createServer(apiHandler('prod'));
const defaultApi = http.createServer(apiHandler('default'));
const selectedUrl = await listen(selectedApi);
const defaultUrl = await listen(defaultApi);

function caseArgs(name, kubeconfig) {
  const target = ['--context', 'prod', '--kubeconfig', kubeconfig, '-n', 'staging', '--as', 'reader'];
  switch (name) {
    case 'pods': return ['oc', 'pods', ...target];
    case 'leading': return ['oc', ...target, 'pods'];
    case 'services': return ['oc', 'services', ...target];
    case 'logs': return ['oc', ...target, 'logs', 'api', '-c', 'app'];
    case 'get-wide': return ['oc', '--context', 'prod', '--kubeconfig', kubeconfig, 'get', '-o', 'wide', 'pods', '-n', 'staging'];
    case 'forbidden': return ['oc', 'pods', '--context', 'prod', '--kubeconfig', kubeconfig, '--as', 'forbidden'];
    default: throw new Error(`unknown case ${name}`);
  }
}

async function execute(variant, name) {
  if (!Object.hasOwn(binaries, variant)) throw new Error('unknown binary');
  const run = `${variant}-${name}-${randomUUID()}`;
  const home = path.join(work, 'evidence', run);
  fs.mkdirSync(home, { recursive: true });
  const kubeconfig = path.join(home, 'cluster config.json');
  fs.writeFileSync(kubeconfig, JSON.stringify({
    kind: 'Config', apiVersion: 'v1', 'current-context': 'default',
    clusters: [
      { name: 'default', cluster: { server: defaultUrl } },
      { name: 'prod', cluster: { server: selectedUrl } },
    ],
    contexts: [
      { name: 'default', context: { cluster: 'default', namespace: 'default' } },
      { name: 'prod', context: { cluster: 'prod', namespace: 'default' } },
    ],
    users: [],
  }));
  const args = caseArgs(name, kubeconfig);
  activeRun = run;
  const started = Date.now();
  const result = await new Promise((resolve, reject) => {
    const child = spawn(binaries[variant], args, {
      cwd: home, timeout: 20000,
      env: {
        PATH: `${path.dirname(oc)}:/usr/bin:/bin`,
        HOME: home, XDG_CONFIG_HOME: path.join(home, 'config'),
        XDG_DATA_HOME: path.join(home, 'data'), LC_ALL: 'C',
        RTK_DB_PATH: path.join(home, 'rtk/history.db'),
        RTK_TEE_DIR: path.join(home, 'rtk/tee'),
        RTK_RECALL_DB: path.join(home, 'rtk/recall.db'),
        RTK_TELEMETRY_DISABLED: '1', KUBECTL_KUBERC: 'false',
        NO_COLOR: '1',
      },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', bytes => { stdout += bytes; });
    child.stderr.on('data', bytes => { stderr += bytes; });
    child.on('error', reject);
    child.on('close', (exit, signal) => resolve({ exit, signal, stdout, stderr }));
  });
  const record = {
    variant, case: name, command: ['rtk', ...args].map(a => a === kubeconfig ? '"<isolated kubeconfig>"' : a).join(' '),
    args: args.map(a => a === kubeconfig ? '<isolated kubeconfig>' : a),
    ...result, elapsedMs: Date.now() - started,
    requests: requests.filter(request => request.run === run),
    binarySha256: createHash('sha256').update(fs.readFileSync(binaries[variant])).digest('hex'),
  };
  fs.writeFileSync(path.join(output, `${variant}-${name}.txt`),
    `$ ${record.command}\nexit: ${record.exit}\n\nstdout:\n${record.stdout}\nstderr:\n${record.stderr}\n`);
  return record;
}

const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>RTK #4614 CLI evidence</title>
<style>
body{margin:0;padding:36px;background:#10161d;color:#e1e9f1;font:16px system-ui}
h1{font-size:28px;margin:0 0 8px}p{color:#a9bdd0;margin:8px 0 24px;line-height:1.6}
button,select{padding:10px 16px;border:1px solid #486178;border-radius:6px;background:#192632;color:inherit;font:inherit;cursor:pointer}
.controls{display:flex;gap:12px;align-items:center;margin-bottom:24px}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}section{background:#080e14;border:1px solid #354455;border-radius:8px;padding:22px;min-width:0}
h2{margin:0 0 16px;font-size:21px}.before{color:#f0aa90}.after{color:#83d7b0}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:15px/1.6 ui-monospace,Menlo,monospace;margin:0}
.note{font-size:13px;margin-top:20px}#status{color:#9ad1ff}small{font-weight:normal;color:#9eacbd}
</style><h1>RTK #4614 · Real CLI before / after</h1>
<p>Real RTK binaries + OpenShift oc 4.22.18 · isolated, simulated Kubernetes API<br>
No production cluster, user credentials, or installed RTK configuration is used.</p>
<div class="controls"><select id="case" aria-label="Test case"><option value="pods">Pod alias with target flags</option>
<option value="leading">Flags before the alias</option><option value="services">Service alias</option>
<option value="logs">Logs + container</option><option value="get-wide">Explicit wide output (control)</option>
<option value="forbidden">Forbidden identity</option></select>
<button id="before">Run original</button><button id="after">Run fixed</button><span id="status">Ready</span></div>
<div class="grid"><section><h2 class="before">Before <small>develop e542dca0</small></h2><pre id="before-output">Click Run original.</pre></section>
<section><h2 class="after">After <small>fix/oc-global-flags</small></h2><pre id="after-output">Click Run fixed.</pre></section></div>
<p class="note">These panels display captured process output, not a product UI mockup. HTTP request paths and impersonation headers are checked separately in the machine-readable matrix.</p>
<script>
for (const variant of ['before','after']) document.getElementById(variant).onclick=async()=>{
 const status=document.getElementById('status');status.textContent='Running '+variant+'…';
 try{const r=await fetch('/run?variant='+variant+'&case='+document.getElementById('case').value);const x=await r.json();
 if(!r.ok)throw Error(x.error);document.getElementById(variant+'-output').textContent='$ '+x.command+'\\n\\nexit: '+x.exit+'\\n\\n'+(x.stdout?'stdout:\\n'+x.stdout:'')+(x.stderr?'stderr:\\n'+x.stderr:'')+'\\nAPI requests: '+x.requests.length;status.textContent='Captured '+variant;
 }catch(e){status.textContent=String(e);}
};
</script></html>`;

let busy = false;
const demo = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html);
  }
  if (busy) return json(res, { error: 'another isolated run is active' }, 409);
  busy = true;
  try {
    if (url.pathname === '/run') return json(res, await execute(url.searchParams.get('variant'), url.searchParams.get('case')));
    if (url.pathname === '/matrix') {
      const results = [];
      for (const name of ['pods', 'leading', 'services', 'logs', 'get-wide', 'forbidden']) {
        for (const variant of ['before', 'after']) results.push(await execute(variant, name));
      }
      for (const result of results) {
        const forbidden = result.case === 'forbidden';
        const brokenBefore = result.variant === 'before' && ['pods', 'leading', 'services'].includes(result.case);
        assert.equal(result.exit, forbidden || brokenBefore ? 1 : 0, `${result.variant}/${result.case}: ${result.stderr}`);
        assert.ok(result.requests.every(r => r.cluster === 'prod'), 'must not reach the default cluster');
        if (result.variant === 'after') {
          assert.ok(result.requests.length > 0, 'the native CLI must make an API request');
          if (!forbidden) assert.ok(result.requests.some(r => r.path.includes('/namespaces/staging/')), 'must keep namespace');
          if (!['get-wide'].includes(result.case)) assert.ok(result.requests.every(r => r.impersonateUser === (forbidden ? 'forbidden' : 'reader')), 'must keep identity');
        }
      }
      for (const name of ['logs', 'get-wide']) {
        assert.equal(results.find(r => r.case === name && r.variant === 'before').stdout,
          results.find(r => r.case === name && r.variant === 'after').stdout, `${name} control output`);
      }
      assert.match(results.find(r => r.case === 'pods' && r.variant === 'after').stdout, /19 pods:/);
      assert.match(results.find(r => r.case === 'forbidden' && r.variant === 'after').stderr, /Forbidden/);
      const report = { capturedAt: new Date().toISOString(), environment: 'real RTK + real oc 4.22.18, simulated local Kubernetes API; existing pod fixture adapted to requested namespace', validation: 'all 12 binary/case combinations and targeting/control invariants passed', results };
      fs.writeFileSync(path.join(output, 'http-comparison.json'), JSON.stringify(report, null, 2) + '\n');
      return json(res, report);
    }
    return json(res, { error: 'not found' }, 404);
  } catch (error) {
    return json(res, { error: String(error) }, 500);
  } finally { busy = false; }
});
const demoUrl = await listen(demo);
fs.writeFileSync(path.join(work, 'evidence-url.txt'), `${demoUrl}\n`);
console.log(JSON.stringify({ demoUrl, selectedUrl, defaultUrl, pid: process.pid }));
function stop() {
  for (const server of [demo, selectedApi, defaultApi]) server.close();
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
