import './test-support/isolated-state.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';

const rest = createServer((request, response) => {
  requests.push([request.method, request.url, request.headers.accept]);
  response.writeHead(200, { 'Content-Type': 'application/vnd.olrapi.note+json' });
  response.end(JSON.stringify(restNote));
}).listen(0, '127.0.0.1');
await once(rest, 'listening');
after(() => new Promise((resolve) => rest.close(resolve)));

process.env.OBSIDIAN_API_KEY = 'test-loopback';
process.env.OBSIDIAN_BASE_URL = `http://127.0.0.1:${rest.address().port}`;
process.env.OBSIDIAN_RUNTIME_MODE = 'hybrid';
process.env.MCP_LOG_LEVEL = 'error';
const {processObsidianReadNote,ObsidianReadNoteInputSchema}=await import('../dist/mcp-server/tools/obsidianReadNoteTool/logic.js');
const content='---\ncustom: élysia\n---\n## Lecture\n\nUn texte avec accents ✅\n';
const stat={ctime:1700000000000,mtime:1700000000000,size:Buffer.byteLength(content)};
const context={requestId:'optional-stats-test',timestamp:new Date().toISOString(),operation:'test'};
for(const format of ['markdown',undefined]){
 const input=ObsidianReadNoteInputSchema.parse({filePath:'Test.md',format});
 const api={getFileContent:async()=>({content,get stat(){throw new Error('Unexpected statistics access');}})};
 const out=await processObsidianReadNote(input,context,api);assert.equal(out.content,content);assert.equal(out.stats,undefined);
}
const api={getFileContent:async()=>({content,stat,path:'Test.md',frontmatter:{custom:'élysia'},tags:[]})};
const cache={isReady:()=>true,findMatchingPath:path=>path,getEntry:async()=>({content,...stat})};
for(const service of [api,undefined]){
 let expectedTokens;
 for(const input of [{format:'markdown'},{format:'markdown',includeStat:true},{format:'json'}]){
  const out=await processObsidianReadNote(ObsidianReadNoteInputSchema.parse({filePath:'Test.md',...input}),context,service,cache);
  assert.equal(typeof out.content==='string'?out.content:out.content.content,content);
  if(input.includeStat||input.format==='json'){
   assert.ok(out.stats.tokenCountEstimate>0);expectedTokens??=out.stats.tokenCountEstimate;
   assert.equal(out.stats.tokenCountEstimate,expectedTokens);
  }else assert.equal(out.stats,undefined);
 }
}
console.log('PASS live/cache Markdown, optional stats, JSON metadata and unchanged Unicode content');

const { ObsidianRestApiService } = await import('../dist/services/obsidianRestAPI/service.js');
const { registerObsidianReadNoteTool } = await import('../dist/mcp-server/tools/obsidianReadNoteTool/registration.js');
const { registerObsidianGetFrontmatterTool } = await import('../dist/mcp-server/tools/obsidianGetFrontmatterTool/registration.js');
const server = new McpServer({ name: 'note-read-test', version: '1' });
const service = new ObsidianRestApiService();
await registerObsidianReadNoteTool(server, service, undefined);
registerObsidianGetFrontmatterTool(server, service);
const client = new Client({ name: 'note-read-test-client', version: '1' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
after(async () => {
  await client.close();
  await server.close();
});
await server.connect(serverTransport);
await client.connect(clientTransport);

const requests = [];
let restNote;
const filePath = 'Test.md';
const yamlContent = [
  '---',
  'modification: 2026-02-02T11:11:00Z',
  'published: 2026-01-01',
  'custom: { labels: [one, 2, false], enabled: true }',
  'tags: [current]',
  'added: null',
  'position: reserved by Obsidian',
  '---',
  '# Body #inline',
].join('\r\n');
const current = {
  modification: '2026-02-02T11:11:00Z',
  published: '2026-01-01',
  custom: { labels: ['one', 2, false], enabled: true },
  tags: ['current'],
  added: null,
};
function serve(frontmatter, markdown = yamlContent) {
  restNote = {
    content: markdown,
    frontmatter,
    path: filePath,
    stat: { ...stat, size: Buffer.byteLength(markdown) },
    tags: ['cached'],
  };
  requests.length = 0;
}

async function call(name, args) {
  const result = await client.callTool({ name, arguments: { filePath, ...args } });
  assert.equal(result.isError, false, result.content[0].text);
  return result.content[0].text;
}

const stale = {
  modification: '2026-01-01T10:00:00Z',
  published: '2026-01-01',
  custom: { enabled: true, labels: ['one', 2, false] },
  tags: ['cached'],
  removed: true,
};
const staleKeys = { keys: ['added', 'modification', 'removed', 'tags'] };

test('JSON note reads reconcile stale REST frontmatter and tags from the same content', async () => {
  serve(stale);
  const { content: note } = JSON.parse(await call('obsidian_read_note', { format: 'json' }));
  assert.deepEqual(note.frontmatter, current);
  assert.deepEqual(note.metadataCacheStale, staleKeys);
  assert.equal(note.content, yamlContent);
  assert.deepEqual(note.stat, restNote.stat);
  assert.deepEqual(note.tags, ['current', 'inline']);
});

test('key reads return the current date and detect removed keys with one REST GET per read', async () => {
  serve(stale);
  const value = JSON.parse(await call('obsidian_get_frontmatter', { key: 'modification' }));
  assert.equal(value.value, current.modification);
  assert.deepEqual(value.metadataCacheStale, staleKeys);
  const removed = JSON.parse(await call('obsidian_get_frontmatter', { key: 'removed' }));
  assert.equal(Object.hasOwn(removed, 'value'), false);
  assert.deepEqual(removed.metadataCacheStale, staleKeys);
  const request = ['GET', '/vault/Test.md', 'application/vnd.olrapi.note+json'];
  assert.deepEqual(requests, [request, request]);
});

test('matching frontmatter keeps the exact response, including cached property order', async () => {
  serve({ ...current, custom: { enabled: true, labels: ['one', 2, false] } });
  const text = await call('obsidian_read_note', { format: 'json' });
  assert.equal(text, JSON.stringify({
    content: { ...restNote, tags: ['current', 'inline'] },
    stats: JSON.parse(text).stats,
    sha256: createHash('sha256').update(restNote.content, 'utf8').digest('hex'),
  }, null, 2));
  assert.equal(await call('obsidian_get_frontmatter', { key: 'custom' }), JSON.stringify({
    success: true,
    message: "Successfully retrieved key 'custom' from frontmatter.",
    value: restNote.frontmatter.custom,
  }));
});

test('removing the entire YAML block clears cached properties', async () => {
  serve({ removed: true }, '# Body');
  const { content: note } = JSON.parse(await call('obsidian_read_note', { format: 'json' }));
  assert.deepEqual(note.frontmatter, {});
  assert.deepEqual(note.metadataCacheStale, { keys: ['removed'] });
});

test('unparseable frontmatter leaves cached properties available', async () => {
  serve({ status: 'cached' }, '---\nstatus: [unclosed\n---\n# Body');
  const { content: note } = JSON.parse(await call('obsidian_read_note', { format: 'json' }));
  assert.deepEqual(note.frontmatter, restNote.frontmatter);
  assert.equal(Object.hasOwn(note, 'metadataCacheStale'), false);
});

test('an opening fence with trailing whitespace is Markdown, not frontmatter', async () => {
  serve({}, '--- \r\nstatus: draft\r\n---\r\n# Body');
  const { content: note } = JSON.parse(await call('obsidian_read_note', { format: 'json' }));
  assert.deepEqual(note.frontmatter, {});
  assert.equal(Object.hasOwn(note, 'metadataCacheStale'), false);
});

test('reading YAML template placeholders does not send collection keys to stderr', async (t) => {
  const emitWarning = t.mock.method(process, 'emitWarning', () => {});
  serve({ status: 'cached' }, '---\nstatus: draft\ntemplate: {{VALUE:x}}\n---\n# Body');
  const result = JSON.parse(await call('obsidian_get_frontmatter', { key: 'status' }));
  assert.equal(result.value, 'draft');
  assert.deepEqual(result.metadataCacheStale, { keys: ['status', 'template'] });
  assert.equal(emitWarning.mock.callCount(), 0);
});
