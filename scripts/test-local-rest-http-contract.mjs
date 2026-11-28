import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
const aliasDir = 'Alias Folder';
const aliasNames = [
  ['Wide Space.md', 'Wide\u00a0Space.md'],
  ['Narrow Space.md', 'Narrow\u202fSpace.md'],
  ['Caf\u00e9.md', 'Cafe\u0301.md'],
  [' Leading.md', '\u00a0Leading.md'],
];
const aliasFiles = aliasNames.map(([name]) => name);
const collisionName = 'Collision Space.md';
const collisionDiskName = 'Collision\u00a0Space.md';
const collisionBody = '# Different physical note';
const collisionPath = aliasDir + '/' + collisionDiskName;
const liveDir = 'Live Fixture';
const liveDiskDir = 'Live\u00a0Fixture';
const liveNames = [
  ['Wide Space.md', 'Wide\u00a0Space.md'],
  ['Narrow Space.md', 'Narrow\u202fSpace.md'],
  ['Ordinary.md', 'Ordinary.md'],
  ['Ambiguous Space.md', null],
];
const livePaths = liveNames.map(([name]) => liveDir + '/' + name);
mkdirSync(path.join(temporary, liveDiskDir));
for (const diskName of [...liveNames.map(([, name]) => name).filter(Boolean),
  'Ambiguous\u00a0Space.md', 'Ambiguous\u202fSpace.md']) {
  writeFileSync(path.join(temporary, liveDiskDir, diskName), note.content, 'utf8');
}
const ordinaryPaths = ['Note.md', 'Plain Space.md'];
for (const filename of ordinaryPaths) {
  writeFileSync(path.join(temporary, filename), note.content, 'utf8');
}
const server = createServer(async (req, res) => {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString('utf8');
  requests.push({ method: req.method, url: req.url, headers: req.headers, body });
  if (req.headers.authorization !== 'Bearer ' + secret) {
    res.writeHead(401, {'Content-Type':'application/json'}).end(JSON.stringify({message: sentinel}));
    return;
  }
  const vaultPath = decodeURIComponent(req.url ?? '');
  if (req.method === 'POST' && req.url?.startsWith('/search/simple/')) {
    const results = [...livePaths, ...ordinaryPaths].map(filename => ({ filename, matches: [], score: 0 }));
    res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(results));
    return;
  }
  if (req.method === 'GET' && vaultPath.startsWith('/vault/' + liveDir + '/')) {
    const filePath = vaultPath.slice('/vault/'.length);
    const payload = filePath === liveDir + '/' ? { files: liveNames.map(([name]) => name) }
      : livePaths.includes(filePath) ? { ...note, path: filePath } : null;
    res.writeHead(payload ? 200 : 404, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(payload ?? { message: 'Not found' }));
    return;
  }
  if (req.method === 'GET' && vaultPath.startsWith('/vault/Alias')) {
    const filePath = vaultPath.slice('/vault/'.length);
    if (req.headers.accept === 'text/markdown') {
      const exactBody = filePath.toLowerCase() === collisionPath.toLowerCase() ? collisionBody
        : aliasNames.some(([, diskName]) => filePath === aliasDir + '/' + diskName)
          ? note.content : undefined;
      if (exactBody !== undefined) {
        res.writeHead(200, { 'Content-Type': 'text/markdown' }).end(exactBody);
        return;
      }
    }
    const indexedFiles = [...aliasFiles, collisionName];
    const payload = filePath === aliasDir + '/' ? { files: indexedFiles }
      : indexedFiles.some(name => filePath === aliasDir + '/' + name) &&
        req.headers.accept === 'application/vnd.olrapi.note+json'
        ? { ...note, path: filePath } : null;
    res.writeHead(payload ? 200 : 404, { 'Content-Type': 'application/json' })
      .end(JSON.stringify(payload ?? { message: 'Not found' }));
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
    req.url === '/vault/' ? {files:['Rich/', 'Note.md', liveDir + '/', 'Plain Space.md']} :
    req.url === '/vault/Rich/' ? {files:['Note.md']} : note;
  const send = () => { if (!res.destroyed) res.writeHead(200, {
    'Content-Type':'application/json', 'Content-Location':'Rich/Note.md'
  }).end(JSON.stringify(payload)); };
  if (delayStatus && req.url === '/') {
    const timer = setTimeout(() => {timers.delete(timer); send();}, 100);
    timers.add(timer);
  } else send();
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const changedEnvKeys = ['OBSIDIAN_RUNTIME_MODE','OBSIDIAN_VAULT','OBSIDIAN_API_KEY','OBSIDIAN_BASE_URL',
  'LOGS_DIR','MCP_WRITE_MODE','OBSIDIAN_ENABLE_CACHE','SEMANTIC_SEARCH_PREWARM','NO_PROXY','no_proxy'];
const originalEnv = Object.fromEntries(changedEnvKeys.map(key => [key,process.env[key]]));
Object.assign(process.env, { NO_PROXY:'*', no_proxy:'*',
  OBSIDIAN_RUNTIME_MODE:'headless-readonly', OBSIDIAN_VAULT:temporary,
  OBSIDIAN_API_KEY:secret, OBSIDIAN_BASE_URL:'http://127.0.0.1:' + server.address().port,
  LOGS_DIR:logs, MCP_WRITE_MODE:'readonly',
  OBSIDIAN_ENABLE_CACHE:'false', SEMANTIC_SEARCH_PREWARM:'false',
});
const {ObsidianRestApiService} = await import('../dist/services/obsidianRestAPI/service.js');
const {BaseErrorCode} = await import('../dist/types-global/errors.js');
const {publicMcpToolErrorPayload} = await import('../dist/utils/internal/errorHandler.js');
const {processObsidianReadNote} = await import('../dist/mcp-server/tools/obsidianReadNoteTool/logic.js');
const {processObsidianListNotes, ObsidianListNotesInputSchema} = await import('../dist/mcp-server/tools/obsidianListNotesTool/logic.js');
const {processObsidianGlobalSearch, ObsidianGlobalSearchInputSchemaShape} =
  await import('../dist/mcp-server/tools/obsidianGlobalSearchTool/logic.js');
const {z} = await import('zod/v3');
const api = new ObsidianRestApiService();
const context = {requestId:'rest-contract', timestamp:new Date(0).toISOString(), operation:'test'};

after(async () => {
  for (const timer of timers) clearTimeout(timer);
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  rmSync(temporary, {recursive:true,force:true});
  rmSync(logs, {recursive:true,force:true});
  for (const [key,value] of Object.entries(originalEnv)) { if(value===undefined)delete process.env[key];else process.env[key]=value; }
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
  assert.deepEqual(await api.listFiles('/', context), ['Rich/','Note.md', liveDir + '/', 'Plain Space.md']);
  assert.deepEqual(await api.getFileMetadata('Note.md', context), {ctime:1000,mtime:2000,size:7});
  for (const [dirPath, entryPath] of [['/Rich', '/Rich/Note.md'], ['Rich/', 'Rich/Note.md']]) {
    const listed = await processObsidianListNotes(
      ObsidianListNotesInputSchema.parse({ dirPath, responseMode: 'compact' }), context, api);
    assert.equal(listed.directoryPath, dirPath);
    assert.equal(listed.entries[0].path, entryPath);
  }
});
test('Obsidian JSON reads accept physical Unicode names and the paths returned by list', async () => {
  const read = (filePath, format = 'json') =>
    processObsidianReadNote({ filePath, format, includeStat: false }, context, api);
  const list = (dirPath) => processObsidianListNotes(
    ObsidianListNotesInputSchema.parse({ dirPath, responseMode: 'compact' }), context, api);
  const listed = await list(aliasDir);
  for (const [name, diskName] of aliasNames) {
    const path = aliasDir + '/' + name;
    assert.ok(listed.entries.some(entry => entry.path === path));
    assert.equal((await read(path)).content.path, path);
    const physical = await read(aliasDir + '/' + diskName);
    assert.equal(physical.content.path, path);
    assert.equal(Object.hasOwn(physical, 'diskPath'), false);
    assert.equal(decodeURIComponent(requests.at(-1).url), '/vault/' + aliasDir + '/' + diskName);
    assert.equal(requests.at(-1).headers.accept, 'text/markdown');
  }
  const byDiskDirectory = await list('Alias\u00a0Folder');
  assert.deepEqual(byDiskDirectory.entries, listed.entries);
  const folded = await read('Alias\u00a0Folder\\wide\u00a0space.md', 'markdown');
  assert.equal(folded.content, note.content);
  const indexedCollision = aliasDir + '/' + collisionName;
  assert.equal((await read(indexedCollision)).content.content, note.content);
  for (const requestedPath of [collisionPath, aliasDir + '/' + collisionDiskName.toLowerCase()]) {
    await assert.rejects(() => read(requestedPath), error => {
      const outcome = publicMcpToolErrorPayload(error, {
        operation: 'alias collision fixture', toolName: 'obsidian_read_note',
        params: { filePath: requestedPath },
      });
      assert.equal(outcome.error.code, BaseErrorCode.CONFLICT);
      assert.equal(outcome.error.details.reasonCode, 'vault_path_alias_ambiguous');
      assert.match(outcome.error.message, /alias returned different content/);
      const serialized = JSON.stringify(outcome);
      assert.ok(!serialized.includes(collisionBody) && !serialized.includes(note.content));
      assert.ok(!serialized.includes(requestedPath));
      return true;
    });
  }
  assert.equal((await read(' Rich/Note.md ')).content.path, note.path);
  assert.equal(requests.at(-1).url, '/vault/Rich/Note.md');
});

function assertLiveDiskPaths(entries) {
  for (const [name, diskName] of liveNames) {
    const entry = entries.find(result => result.path === liveDir + '/' + name);
    assert.ok(entry, `expected the REST path for ${name}`);
    if (diskName) assert.equal(entry.diskPath, liveDiskDir + '/' + diskName);
    else assert.equal(Object.hasOwn(entry, 'diskPath'), false);
  }
}

function assertOrdinaryPaths(entries) {
  for (const filename of ordinaryPaths) {
    const entry = entries.find(result => result.path === filename);
    assert.ok(entry, `expected the ordinary REST path ${filename}`);
    assert.equal(Object.hasOwn(entry, 'diskPath'), false);
  }
}

for (const [dirPath, recursionDepth] of [[liveDir, 0], ['/', -1]]) {
  test(`live compact listing resolves disk spelling from ${dirPath}`, async () => {
    const listed = await processObsidianListNotes(
      ObsidianListNotesInputSchema.parse({ dirPath, recursionDepth }), context, api);
    assertLiveDiskPaths(listed.entries);
    if (dirPath === '/') {
      assert.equal(listed.entries.find(entry => entry.path === liveDir + '/').diskPath, liveDiskDir + '/');
      assertOrdinaryPaths(listed.entries);
    }
  });
}

for (const [query, useRegex] of [['Heading', false], ['Head.ng', true]]) {
  for (const responseMode of ['compact', 'detailed']) {
    test(`live ${responseMode} search resolves disk spelling for ${useRegex ? 'regex' : 'text'}`, async () => {
      const search = await processObsidianGlobalSearch(
        z.object(ObsidianGlobalSearchInputSchemaShape).parse({ query, useRegex, responseMode }),
        context, api);
      assertLiveDiskPaths(search.results);
      assertOrdinaryPaths(search.results);
    });
  }
}

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
