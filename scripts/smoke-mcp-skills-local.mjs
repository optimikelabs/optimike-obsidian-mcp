#!/usr/bin/env node
/** Operator canary. Never applies an operation or changes configuration.
 * Writes only the explicitly selected receipt. See docs/mcp-skills-local.md.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstat, open, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyHTTP } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport as LegacyStdio } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ExternalRootsService } from '../dist/services/externalRootsService.js';
import { SkillRegistry, readSkillsPublicationConfig } from '../dist/services/skills/skillRegistry.js';
import { ListSkillsClientResultSchema, GetSkillClientResultSchema } from '../dist/mcp-server/resources/skillsSchemas.js';
import { requireObservedDesktop } from './skills-local-proof.mjs';

const repo = fileURLToPath(new URL('..', import.meta.url));
const revision = '2026-07-28';
const extension = 'io.modelcontextprotocol/skills';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const requestOptions = { timeout: 15_000 };
const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function verifyResourceBytes(resource, contents) {
  assert.match(resource.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(Number.isSafeInteger(resource.size) && resource.size >= 0 && resource.size <= 16 * 1024 * 1024);
  assert.equal(contents.length, 1);
  const item = contents[0];
  assert.equal(item.uri, resource.uri);
  assert.notEqual(typeof item.text === 'string', typeof item.blob === 'string');
  const bytes = typeof item.text === 'string' ? Buffer.from(item.text, 'utf8') : Buffer.from(item.blob, 'base64');
  if (typeof item.blob === 'string') assert.equal(bytes.toString('base64'), item.blob);
  assert.equal(bytes.length, resource.size);
  assert.equal('sha256:' + sha256(bytes), resource.digest);
  return bytes.length;
}

/** Bounded source projection, not a claim about plugin caches or attachments.
 * No paths or contents are emitted. Concurrent changes fail the canary.
 */
export async function snapshotVaultDocuments(vault) {
  assert.ok(path.isAbsolute(vault));
  const root = await lstat(vault);
  assert.ok(root.isDirectory() && !root.isSymbolicLink());
  const rows = []; let visited = 0; let totalBytes = 0;
  const skip = new Set(['.obsidian', '.smart-env', '.trash', '.git', 'node_modules']);
  async function walk(directory, relative = '') {
    for (const name of (await readdir(directory)).sort()) {
      assert.ok(++visited <= 40_000, 'document snapshot entry limit');
      if (skip.has(name)) continue;
      const full = path.join(directory, name);
      const rel = relative ? relative + '/' + name : name;
      const stat = await lstat(full, { bigint: true });
      assert.ok(!stat.isSymbolicLink(), 'document snapshot refuses links');
      if (stat.isDirectory()) { await walk(full, rel); continue; }
      if (!stat.isFile() || !/\.(?:md|markdown|base|canvas)$/iu.test(name)) continue;
      assert.ok(stat.size <= 16n * 1024n * 1024n, 'document snapshot file limit');
      totalBytes += Number(stat.size);
      assert.ok(totalBytes <= 512 * 1024 * 1024 && rows.length < 20_000, 'document snapshot total limit');
      const handle = await open(full, 'r');
      try {
        const before = await handle.stat({ bigint: true });
        assert.equal(before.dev, stat.dev); assert.equal(before.ino, stat.ino); assert.equal(before.size, stat.size);
        const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          assert.ok(read.bytesRead > 0); offset += read.bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        const final = await lstat(full, { bigint: true });
        for (const key of ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs']) {
          assert.equal(before[key], after[key]); assert.equal(after[key], final[key]);
        }
        assert.ok(!final.isSymbolicLink()); rows.push([rel, sha256(bytes), bytes.length]);
      } finally { await handle.close(); }
    }
  }
  await walk(vault);
  return { scope: 'markdown/base/canvas; excludes plugin/cache/trash/git/node_modules', files: rows.length, bytes: totalBytes, sha256: sha256(JSON.stringify(rows)) };
}

export async function qualifyLocalSkills(env = process.env) {
  const expected = env.MCP_SMOKE_EXPECTED_SHA;
  assert.match(expected ?? '', /^[a-f0-9]{40}$/u, 'exact candidate required');
  assert.equal(git('rev-parse', 'HEAD'), expected, 'checkout differs from candidate');
  assert.equal(git('status', '--porcelain'), '', 'checkout must be clean');
  const transportMode = env.MCP_SMOKE_TRANSPORT ?? 'stdio';
  assert.ok(['stdio', 'proxy', 'http'].includes(transportMode));
  const profile = env.MCP_TOOL_PROFILE ?? 'full';
  assert.ok(['standard', 'authoring', 'tasks', 'full'].includes(profile));
  const requireLive = env.MCP_SMOKE_REQUIRE_LIVE !== 'false';
  const rootsPath = env.MCP_EXTERNAL_ROOTS_FILE; const configPath = env.MCP_SKILLS_CONFIG_FILE;
  assert.ok(rootsPath && configPath && path.isAbsolute(rootsPath) && path.isAbsolute(configPath));
  const configBefore = [sha256(await readFile(rootsPath)), sha256(await readFile(configPath))];
  const sources = await ExternalRootsService.fromConfigFile(rootsPath);
  const registry = new SkillRegistry(sources, await readSkillsPublicationConfig(configPath), profile);
  const audit = await registry.audit();
  const eligible = audit.filter(item => item.state === 'eligible');
  assert.ok(eligible.length > 0, 'at least one eligible publication required');
  const expectedUris = (env.MCP_SMOKE_EXPECT_SKILLS ?? '').split(/[\s,]+/u).filter(Boolean);
  for (const uri of expectedUris) assert.ok(eligible.some(item => item.uri === uri), 'required publication refused');
  const localEntries = await Promise.all(eligible.map(async item => (await registry.get(item.uri)).skill));
  const before = await snapshotVaultDocuments(env.MCP_SMOKE_VAULT ?? '');
  const clients = [];
  try {
    async function connect(legacy) {
      const client = legacy ? new LegacyClient({ name: 'optimike-local-legacy-canary', version: '1' })
        : new Client({ name: 'optimike-local-skills-canary', version: '1' }, { versionNegotiation: { mode: { pin: revision } } });
      clients.push(client);
      let transport;
      if (transportMode === 'http') {
        const url = new URL(env.MCP_SMOKE_HTTP_URL);
        assert.ok(!url.username && !url.password);
        assert.ok(url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)));
        const options = { requestInit: { headers: env.MCP_SMOKE_BEARER_TOKEN ? { Authorization: `Bearer ${env.MCP_SMOKE_BEARER_TOKEN}` } : {} } };
        transport = legacy ? new LegacyHTTP(url, options) : new StreamableHTTPClientTransport(url, options);
      } else {
        const options = { command: process.execPath, args: [path.join(repo, 'dist', transportMode === 'proxy' ? 'stdio-proxy.js' : 'index.js'), '--tool-profile', profile], cwd: repo,
          env: { ...env, MCP_TRANSPORT_TYPE: 'stdio', MCP_PROTOCOL_MODE: 'dual' }, stderr: 'pipe' };
        transport = legacy ? new LegacyStdio(options) : new StdioClientTransport(options);
        transport.stderr?.on('data', () => {});
      }
      await client.connect(transport); return client;
    }
    const modern = await connect(false); const legacy = await connect(true);
    assert.equal(modern.getNegotiatedProtocolVersion(), revision);
    assert.deepEqual(modern.getServerCapabilities()?.extensions?.[extension], {});
    assert.ok(modern.getServerCapabilities()?.resources);
    assert.equal(legacy.getServerCapabilities()?.extensions?.[extension], undefined);
    const catalog = result => result.tools.map(tool => [tool.name, tool.annotations?.readOnlyHint === true]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
    const modernTools = catalog(await modern.listTools());
    assert.deepEqual(modernTools, catalog(await legacy.listTools()));
    assert.ok(!modernTools.some(([name]) => /^skills[\/_]/u.test(name)));
    const statusResult = await modern.callTool({ name: 'obsidian_runtime_status', arguments: {} });
    assert.notEqual(statusResult.isError, true);
    const status = JSON.parse(statusResult.content.filter(block => block.type === 'text').map(block => block.text).join('\n'));
    const runtimeRevision = status.runtime?.git?.revision;
    assert.match(runtimeRevision ?? '', /^[a-f0-9]{7,40}$/u);
    assert.ok(expected.startsWith(runtimeRevision), 'served runtime differs from checkout');
    if (requireLive) requireObservedDesktop(status);
    const listed = []; const cursors = new Set(); let cursor;
    do {
      const page = await modern.request({ method: 'skills/list', params: cursor ? { cursor } : {} }, ListSkillsClientResultSchema, requestOptions);
      listed.push(...page.skills); cursor = page.nextCursor;
      assert.ok(listed.length <= 64 && cursors.size < 64);
      if (cursor) { assert.ok(!cursors.has(cursor)); cursors.add(cursor); }
    } while (cursor);
    assert.equal(new Set(listed.map(entry => entry.uri)).size, listed.length);
    const locallyListed = []; cursor = undefined;
    do { const page = await registry.list(cursor); locallyListed.push(...page.skills); cursor = page.nextCursor; } while (cursor);
    assert.deepEqual(listed, locallyListed, 'wire listing differs from independent local source');
    let resources = 0; let bytes = 0;
    for (const approved of localEntries) {
      const result = await modern.request({ method: 'skills/get', params: { uri: approved.uri } }, GetSkillClientResultSchema, requestOptions);
      assert.deepEqual(result.skill, approved);
      assert.ok(approved.resources.length > 0 && approved.resources.length <= 512);
      assert.equal(new Set(approved.resources.map(item => item.uri)).size, approved.resources.length);
      assert.ok(approved.resources.some(item => item.uri === approved.uri));
      for (const resource of approved.resources) {
        const read = await modern.readResource({ uri: resource.uri }, requestOptions);
        bytes += verifyResourceBytes(resource, read.contents); resources++;
      }
      assert.deepEqual((await modern.request({ method: 'skills/get', params: { uri: approved.uri } }, GetSkillClientResultSchema, requestOptions)).skill, approved, 'manifest changed during qualification');
      assert.deepEqual((await registry.get(approved.uri)).skill, approved, 'original source changed during qualification');
    }
    const after = await snapshotVaultDocuments(env.MCP_SMOKE_VAULT);
    assert.deepEqual(after, before, 'vault document projection changed');
    assert.deepEqual([sha256(await readFile(rootsPath)), sha256(await readFile(configPath))], configBefore, 'configuration changed');
    return { version: 1, ok: true, candidateSha: expected, runtimeRevision, protocolVersion: revision, transport: transportMode,
      profile, liveDesktopRequired: requireLive, runtimeMode: status.runtimeMode,
      localGate: requireLive ? 'PASS' : 'NOT_EXERCISED', tools: modernTools.length,
      skills: { verified: localEntries.length, resources, bytes, refused: audit.filter(item => item.state === 'refused') },
      sourceProjection: after, sourceAndConfigUnchanged: true, mutationCalls: 0,
      productionDeployment: 'NOT_PERFORMED', observedAt: new Date().toISOString() };
  } finally { await Promise.allSettled(clients.map(client => client.close())); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = process.env.MCP_SMOKE_OUTPUT;
  try {
    assert.ok(output && path.isAbsolute(output), 'absolute receipt path required');
    const result = await qualifyLocalSkills();
    await writeFile(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    console.log('PASS: exact-candidate readonly Skills canary; receipt written. No configuration changed.');
  } catch {
    if (output && path.isAbsolute(output)) await writeFile(output, JSON.stringify({ version: 1, ok: false, reason: 'local_qualification_failed', candidateSha: /^[a-f0-9]{40}$/u.test(process.env.MCP_SMOKE_EXPECTED_SHA ?? '') ? process.env.MCP_SMOKE_EXPECTED_SHA : null }) + '\n', { flag: 'wx', mode: 0o600 }).catch(() => {});
    console.error('FAIL: local qualification or receipt write failed. No raw source, path, token or backend error is printed.');
    process.exitCode = 1;
  }
}
