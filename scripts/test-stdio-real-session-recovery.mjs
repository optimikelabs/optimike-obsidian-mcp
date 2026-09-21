import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createServer} from 'node:net';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(process.env.RECOVERY_TEST_BUILD_ROOT || '.');
const sandbox = await mkdtemp(path.join(tmpdir(), 'optimike-real-recovery-'));
const server = createServer();
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const port = server.address().port;
await new Promise(resolve => server.close(resolve));
const base = `http://127.0.0.1:${port}`;
await mkdir(path.join(sandbox, '.obsidian'));
const logDir=path.join(root,'.tmp',path.basename(sandbox));
await mkdir(logDir,{recursive:true});
await writeFile(path.join(sandbox, 'Sentinel.md'), 'Recovery sentinel unchanged\n', 'utf8');
const env = {...process.env, OBSIDIAN_RUNTIME_MODE:'headless-readonly', OBSIDIAN_VAULT:sandbox,
 OBSIDIAN_CACHE_SOURCE:'filesystem', OBSIDIAN_ENABLE_CACHE:'false', MCP_WRITE_MODE:'readonly',
 SEMANTIC_SEARCH_PREWARM:'false', MCP_HTTP_HOST:'127.0.0.1', MCP_HTTP_PORT:String(port),
 MCP_HTTP_PORT_RETRIES:'0', MCP_TOOL_PROFILE:'full', MCP_HTTP_DEFAULT_TOOL_PROFILE:'full',
 MCP_LOG_LEVEL:'info', LOGS_DIR:logDir,
 MCP_PROXY_REQUIRE_EXISTING_BACKEND:'true'};
delete env.MCP_AUTH_MODE; delete env.MCP_AUTH_SECRET_KEY; delete env.MCP_BACKEND_BEARER_TOKEN;
let backend, client, transport; let stderr = '';
async function start() {
 let startupOutput='';
 backend=spawn(process.execPath,[path.join(root,'dist/index.js')],{cwd:sandbox,env:{...env,MCP_TRANSPORT_TYPE:'http'},stdio:['ignore','pipe','pipe']});
 backend.stderr.on('data',chunk=>{startupOutput+=String(chunk);});
 backend.stdout.on('data',chunk=>{startupOutput+=String(chunk);});
 for(let i=0;i<200;i++) {
  if(backend.exitCode!==null) throw new Error(`backend exit ${backend.exitCode}: ${startupOutput.slice(-4000)}`);
  try {if((await fetch(base+'/healthz')).ok)return;} catch {}
  await new Promise(r=>setTimeout(r,50));
 }
 throw new Error('backend health timeout');
}
async function stop() { if(backend && backend.exitCode===null){ const exited=once(backend,'exit');backend.kill();await exited; } }
async function post(route,body,session) {
 return fetch(base+route,{method:'POST',headers:{Accept:'application/json, text/event-stream','Content-Type':'application/json',...(session?{'Mcp-Session-Id':session}:{})},body:JSON.stringify(body)});
}
const watchdog=setTimeout(()=>{backend?.kill();process.exit(2);},45000);
try {
 await start();
 const init=await post('/mcp/full',{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'wire-test',version:'1'}}});
 assert.equal(init.status,200);const oldSession=init.headers.get('mcp-session-id');assert.ok(oldSession);await init.text();
 transport=new StdioClientTransport({command:process.execPath,args:[path.join(root,'dist/stdio-proxy.js'),'--tool-profile','full'],cwd:sandbox,env:{...env,MCP_TRANSPORT_TYPE:'stdio'},stderr:'pipe'});
 transport.stderr?.on('data',chunk=>{stderr+=String(chunk);});
 client=new Client({name:'real-recovery',version:'1'});await client.connect(transport);
 let result=await client.callTool({name:'obsidian_runtime_status',arguments:{}});
 assert.notEqual(result.isError,true);
 await stop();await start();
 const stale=await post('/mcp/full',{jsonrpc:'2.0',id:2,method:'ping'},oldSession);
 assert.equal(stale.status,404);const error=await stale.json();
 assert.equal(error.error.code,-32012);
 assert.equal(error.error.data.transportReason,'mcp_session_invalid');
 assert.equal(JSON.stringify(error).includes(oldSession),false);
 const unknown=await post('/not-a-resource',{jsonrpc:'2.0',id:3,method:'ping'});
 assert.equal(unknown.status,404);
 assert.equal((await unknown.text()).includes('mcp_session_invalid'),false);
 result=await client.callTool({name:'obsidian_runtime_status',arguments:{}});
 assert.notEqual(result.isError,true);
 const missing=await client.callTool({name:'obsidian_read_note',arguments:{filePath:'Missing.md'}});
 assert.equal(missing.isError,true);
 assert.equal(JSON.stringify(missing).includes('mcp_session_invalid'),false);
 assert.equal((stderr.match(/reconnecting once/g)||[]).length,1);
 assert.equal(stderr.includes(oldSession),false);
 console.log('PASS: real backend restart, same proxy, one reconnect, session-only marker, ordinary missing resource preserved');
} finally {
 clearTimeout(watchdog);await client?.close();await transport?.close();await stop();
 // Only remove the unique fixture directory created in this test.
 assert.equal(path.dirname(sandbox),path.resolve(tmpdir()));
 assert.ok(path.basename(sandbox).startsWith('optimike-real-recovery-'));
 await rm(sandbox,{recursive:true,force:true});
 assert.equal(path.dirname(logDir),path.join(root,'.tmp'));
 await rm(logDir,{recursive:true,force:true});
}
