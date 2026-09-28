import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';

// Real HTTP sockets plus the production Axios adapter, not a Desktop certificate.
// All responses and writes belong to this in-memory disposable fixture.
const temporary = mkdtempSync(path.join(tmpdir(), 'optimike-rest-contract-'));
const logs = path.join(process.cwd(), 'logs', path.basename(temporary));
const secret = 'fixture-key-not-a-real-credential';
const sentinel = 'PRIVATE_NOTE_BODY_AND_SIGNED_URL_SENTINEL';
const requests = [];
let version = '5.3.1';
let delayStatus = false;
const timers = new Set();
const note = { path: 'Rich/Note.md', content: '# Heading\nbody',
  stat: { ctime: 1000, mtime: 2000, size: 7 }, tags: [], frontmatter: {} };
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  requests.push({ method: req.method, url: req.url, headers: req.headers, body });
  if (req.headers.authorization !== 'Bearer ' + secret) {
    res.writeHead(401, {'Content-Type':'application/json'}).end(JSON.stringify({message: sentinel}));
    return;
  }
  const errorStatus = /status-(\d+)\.md/.exec(req.url ?? '');
  if (errorStatus) {
    res.writeHead(Number(errorStatus[1]), {'Content-Type':'application/json'});
    res.end(JSON.stringify({message: sentinel, errorCode: 99999}));
    return;
  }
  if (req.method === 'HEAD') {
    res.writeHead(200, {'x-obsidian-mtime':'2', 'x-obsidian-ctime':'1', 'content-length':'7'}).end();
    return;
  }
  if (req.method === 'PATCH' || req.method === 'PUT' || req.method === 'POST') {
    res.writeHead(204).end();
    return;
  }
  const payload = req.url === '/' ? {service:'Obsidian Local REST API', ok:'OK',
    authenticated:true, versions:{obsidian:'1.13.1',self:version}, extensions:[]} :
    req.url === '/vault/' ? {files:['Rich/','Note.md']} : note;
  const send = () => { if (!res.destroyed) res.writeHead(200, {
    'Content-Type':'application/json', 'Content-Location':'Rich/Note.md'
  }).end(JSON.stringify(payload)); };
  if (delayStatus && req.url === '/') {
    const timer = setTimeout(() => {timers.delete(timer); send();}, 100);
    timers.add(timer);
  } else send();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
Object.assign(process.env, {
  OBSIDIAN_RUNTIME_MODE:'headless-readonly', OBSIDIAN_VAULT:temporary,
  OBSIDIAN_API_KEY:secret, OBSIDIAN_BASE_URL:'http://127.0.0.1:' + server.address().port,
  LOGS_DIR:logs, MCP_WRITE_MODE:'readonly',
  OBSIDIAN_ENABLE_CACHE:'false', SEMANTIC_SEARCH_PREWARM:'false',
});
const {ObsidianRestApiService} = await import('../dist/services/obsidianRestAPI/service.js');
const {BaseErrorCode} = await import('../dist/types-global/errors.js');
const api = new ObsidianRestApiService();
const context = {requestId:'rest-contract', timestamp:new Date(0).toISOString(), operation:'test'};

after(async () => {
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(temporary, {recursive:true,force:true});
  rmSync(logs, {recursive:true,force:true});
});

for (const current of ['5.1.0','5.3.1']) test('status preserves observed version ' + current, async () => {
  version = current;
  const status = await api.checkStatus(context, 1000);
  assert.equal(status.versions.self, current);
  assert.equal(status.authenticated, true);
});

test('rich paths are encoded per segment and JSON reads use the native media type', async () => {
  const result = await api.getFileContent('Rich/\u00c9 #?, %.md', 'json', context);
  assert.deepEqual(result, note);
  const last = requests.at(-1);
  assert.equal(last.url, '/vault/Rich/%C3%89%20%23%3F%2C%20%25.md');
  assert.equal(last.headers.accept, 'application/vnd.olrapi.note+json');
  assert.equal(last.headers.authorization, 'Bearer ' + secret);
});
test('root listing and HEAD metadata stay compatible', async () => {
  assert.deepEqual(await api.listFiles('/', context), ['Rich/','Note.md']);
  assert.deepEqual(await api.getFileMetadata('Note.md', context), {ctime:1000,mtime:2000,size:7});
});
test('active JSON read exposes the resolved file through NoteJson', async () => {
  assert.deepEqual(await api.getActiveFile('json', context), note);
  assert.equal(requests.at(-1).url, '/active/');
});
for (const value of ['text', 0, false, null, ['a',2,true], {nested:{ok:true}}]) {
  test('PATCH keeps typed frontmatter ' + JSON.stringify(value), async () => {
    await api.patchFile('Note.md', value, {targetType:'frontmatter',target:'value',operation:'replace'}, context);
    const request = requests.at(-1);
    assert.equal(request.method, 'PATCH');
    assert.deepEqual(JSON.parse(request.body), {targetType:'frontmatter',target:'value',operation:'replace',value});
    assert.equal(request.headers['content-type'], 'application/json');
    for (const name of ['target','target-type','operation','markdown-patch-version','if-match'])
      assert.equal(request.headers[name], undefined);
  });
}
test('heading levels are sent unchanged: rebasing belongs to upstream, not the client', async () => {
  await api.patchFile('Note.md', '### Child', {targetType:'heading',target:['Root'],
    operation:'append',scope:'content',ifMatch:'sealed-version'}, context);
  assert.deepEqual(JSON.parse(requests.at(-1).body), {targetType:'heading',target:['Root'],
    operation:'append',scope:'content',ifMatch:'sealed-version',content:'### Child'});
});
test('invalid PATCH is rejected before network dispatch', async () => {
  const before = requests.length;
  await assert.rejects(() => api.patchFile('Note.md','unexpected',
    {targetType:'block',target:'id',operation:'delete'}, context));
  assert.equal(requests.length, before);
});
for (const [status, code] of [[400,'VALIDATION_ERROR'],[401,'UNAUTHORIZED'],[403,'FORBIDDEN'],
  [404,'NOT_FOUND'],[405,'VALIDATION_ERROR'],[409,'CONFLICT'],[412,'CONFLICT'],
  [422,'VALIDATION_ERROR'],[503,'SERVICE_UNAVAILABLE']]) {
  test('HTTP ' + status + ' is typed, redacted and not automatically replayed', async () => {
    const before = requests.length;
    await assert.rejects(() => api.getFileContent('status-' + status + '.md','json',context), error => {
      assert.equal(error.code, BaseErrorCode[code]);
      assert.equal(JSON.stringify(error).includes(sentinel), false);
      assert.equal(error.message.includes(sentinel), false);
      return true;
    });
    assert.equal(requests.length - before, 1);
  });
}
test('status timeout remains a failure rather than a synthetic ready state', async () => {
  delayStatus = true;
  try { await assert.rejects(() => api.checkStatus(context, 10), e => e.code === BaseErrorCode.SERVICE_UNAVAILABLE); }
  finally { delayStatus = false; }
});
