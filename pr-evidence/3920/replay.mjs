import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';

const root = import.meta.dirname;
const output = root;
const data = Object.fromEntries(['before', 'after'].map(v =>
  [v, JSON.parse(fs.readFileSync(path.join(output, `${v}-runtime.json`)))]));
const html = `<!doctype html><html lang="en"><meta charset="utf-8">
<title>RTK #3920 — verified native lint output</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#10161d;color:#e1e9f1;font:15px system-ui;padding:24px 32px}
h1{font-size:26px;letter-spacing:-.5px;margin:0 0 6px}p{color:#acbfd2;margin:6px 0 14px;line-height:1.5}
.controls{display:flex;gap:8px;margin:14px 0;align-items:center}button{font:inherit;color:inherit;background:#192632;border:1px solid #486178;border-radius:5px;padding:8px 14px;cursor:pointer}
button[aria-pressed=true]{border-color:#83d7b0;background:#16312b}.sep{width:20px}.stats{display:flex;gap:28px;border-block:1px solid #354455;padding:12px 0;margin-bottom:14px}
.stats span{color:#acbfd2}.stats strong{display:block;color:#e1e9f1;font-size:20px;margin-top:3px}
section{border:1px solid #354455;border-radius:7px;background:#080e14;padding:14px 18px}
h2{font-size:18px;margin:0 0 10px;color:#83d7b0}pre{font:12px/1.42 ui-monospace,Menlo,monospace;white-space:pre-wrap;margin:0;overflow-wrap:anywhere}
.note{font-size:12px;margin-top:12px}#source{margin-left:auto;font:12px ui-monospace,Menlo,monospace;color:#acbfd2}
</style>
<h1>RTK #3920 · Repeated descriptions, stated once</h1>
<p>Viewer of captured real local CLI output — not product UI and not a mocked linter.<br>
Same fixture files, tool versions and environment. Source: original develop e542dca vs the verified patch.</p>
<div class="controls">
<button id="sqlfluff" aria-pressed="true">SQLFluff</button><button id="ruff" aria-pressed="false">Ruff</button><span class="sep"></span>
<button id="before" aria-pressed="true">Before</button><button id="after" aria-pressed="false">After</button><span id="source"></span>
</div>
<div class="stats"><div><span>Native text</span><strong id="native"></strong></div><div><span>This RTK run</span><strong id="bytes"></strong></div>
<div><span>Diagnostics / exit code</span><strong id="diagnostics"></strong></div><div><span>Versus original RTK</span><strong id="saving"></strong></div></div>
<section><h2 id="title"></h2><pre id="terminal" aria-label="Actual captured command stdout"></pre></section>
<p class="note">All locations and rule-specific messages are retained. Different messages for the same code remain beside their locations.<br>
Bytes describe this fixture's command output, not tokenized model requests or API bills. Full raw captures and verification limits accompany this evidence.</p>
<script>
let tool='sqlfluff',variant='before',data;
function render(){
 const r=data[variant].matrix.find(r=>r.tool===tool),b=data.before.matrix.find(r=>r.tool===tool);
 for(const n of ['sqlfluff','ruff'])document.getElementById(n).setAttribute('aria-pressed',String(n===tool));
 for(const n of ['before','after'])document.getElementById(n).setAttribute('aria-pressed',String(n===variant));
 document.getElementById('source').textContent=r.version;
 document.getElementById('native').textContent=r.native.bytes.toLocaleString()+' B';
 document.getElementById('bytes').textContent=r.wrapped.bytes.toLocaleString()+' B';
 document.getElementById('diagnostics').textContent=r.diagnostics.length+' / exit '+r.wrapped.exit;
 document.getElementById('saving').textContent=variant==='before'?'Baseline':(100*(1-r.wrapped.bytes/b.wrapped.bytes)).toFixed(1)+'% fewer bytes';
 document.getElementById('title').textContent=(variant==='before'?'Before · descriptions repeated at each location':'After · identical descriptions in visible rule summaries');
 document.getElementById('terminal').textContent='$ rtk '+r.tool+' '+r.wrapped.args.slice(1).map(a=>a.replace(/^.*\\/fixture\\//,'fixture/')).join(' ')+'\\n\\n'+r.wrapped.stdout;
 document.documentElement.dataset.ready=tool+'-'+variant;
}
for(const n of ['sqlfluff','ruff'])document.getElementById(n).onclick=()=>{tool=n;render()};
for(const n of ['before','after'])document.getElementById(n).onclick=()=>{variant=n;render()};
fetch('/data').then(r=>r.json()).then(d=>{data=d;render()});
</script></html>`;
const server = http.createServer((req, res) => {
  if (req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
  } else if (req.url === '/data') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  } else {
    res.writeHead(req.url === '/favicon.ico' ? 204 : 404);
    res.end();
  }
});
server.listen(0, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(root, 'evidence-url.txt'), url + '\n');
  console.log(JSON.stringify({ url, pid: process.pid }));
});
process.on('SIGTERM', () => server.close());
