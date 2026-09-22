import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fixture, token, revision } from './fixtures/mcp-2026/runtime.mjs';

const f = await fixture();
const bearer = await token('version-review');
const client = new Client({name:'legacy-version-review', version:'1'});
const transport = new StreamableHTTPClientTransport(new URL(f.base+'/mcp/full'), {
  requestInit: {headers: {Authorization:`Bearer ${bearer}`}},
});
let checks = 0;
try {
  await client.connect(transport);
  assert.ok(transport.sessionId);
  const original = await client.listTools();
  for (const method of ['GET','DELETE']) {
    for (const claimed of ['2099-01-01','2025-01-01','PRIVATE_VERSION_SENTINEL']) {
      const response = await fetch(f.base+'/mcp/full', {method, headers:{
        Authorization:`Bearer ${bearer}`,
        Accept:'text/event-stream',
        'MCP-Protocol-Version':claimed,
        'Mcp-Session-Id':transport.sessionId,
      }});
      assert.equal(response.status, 400, `${method} unsupported version must not enter legacy handler`);
      const text = await response.text();
      const body = JSON.parse(text);
      assert.equal(body.error.code, -32022);
      assert.equal(body.id, null);
      assert.equal(text.includes('PRIVATE_VERSION_SENTINEL'),false);
      assert.equal(text.includes(transport.sessionId),false);
      assert.deepEqual((await client.listTools()).tools,original.tools,
        'unsupported GET/DELETE must not consume or close a valid legacy session');
      checks++;
    }
    const modern = await fetch(f.base+'/mcp/full',{method,headers:{
      Authorization:`Bearer ${bearer}`,'MCP-Protocol-Version':revision,
      'Mcp-Session-Id':transport.sessionId,
    }});
    assert.equal(modern.status,405);await modern.text();checks++;
  }
  assert.deepEqual((await client.listTools()).tools,original.tools);
  console.log(`PASS: ${checks} explicit GET/DELETE version guards preserve legacy sessions`);
} finally { await client.close().catch(()=>{});await f.close(); }
