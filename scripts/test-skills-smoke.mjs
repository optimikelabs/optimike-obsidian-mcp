import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { qualifyLocalSkills, verifyResourceBytes, snapshotVaultDocuments } from './smoke-mcp-skills-local.mjs';
import { fixture, token } from './fixtures/mcp-2026/runtime.mjs';

const bytes = Buffer.from([0, 255, 10]);
const resource = { uri: 'skill://sample/SKILL.md', size: bytes.length,
  digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') };
const contents = [{ uri: resource.uri, blob: bytes.toString('base64') }];
assert.equal(verifyResourceBytes(resource, contents), 3);
for (const wrong of [ { ...resource, size: 4 }, { ...resource, digest: 'sha256:' + '0'.repeat(64) }, { ...resource, uri: 'skill://other/SKILL.md' } ]) {
  assert.throws(() => verifyResourceBytes(wrong, contents));
}
assert.throws(() => verifyResourceBytes(resource, [{ ...contents[0], blob: 'AP8K ' }]));
assert.throws(() => verifyResourceBytes(resource, [{ ...contents[0], text: 'ambiguous' }]));

const sandbox = await mkdtemp(path.join(os.tmpdir(), 'optimike-skills-smoke-'));
let backend;
try {
  const skillRoot = path.join(sandbox, 'skills');
  await mkdir(path.join(skillRoot, 'sample', 'references'), { recursive: true });
  await writeFile(path.join(skillRoot, 'sample', 'SKILL.md'), '---\nname: sample\ndescription: Local canary fixture\n---\n[Guide](references/guide.md)\n');
  await writeFile(path.join(skillRoot, 'sample', 'references', 'guide.md'), 'Read only.');
  const roots = path.join(sandbox, 'roots.json'); const publications = path.join(sandbox, 'skills.json');
  await writeFile(roots, JSON.stringify({ version: 1, roots: [{ id: 'canary', path: skillRoot, capabilities: ['visible', 'readable'] }] }));
  await writeFile(publications, JSON.stringify({ version: 1, skills: [{ rootId: 'canary', path: 'sample' }] }));
  backend = await fixture({ MCP_EXTERNAL_ROOTS_FILE: roots, MCP_SKILLS_CONFIG_FILE: publications, MCP_HTTP_MAX_SESSIONS: '20' });
  const bearer = await token('readonly-canary');
  const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const env = { ...backend.env, MCP_SMOKE_EXPECTED_SHA: candidate, MCP_SMOKE_REQUIRE_LIVE: 'false',
    MCP_SMOKE_VAULT: backend.root, MCP_SMOKE_HTTP_URL: backend.base + '/mcp/full',
    MCP_SMOKE_BEARER_TOKEN: bearer, MCP_BACKEND_BEARER_TOKEN: bearer,
    MCP_PROXY_REQUIRE_EXISTING_BACKEND: 'true', MCP_SMOKE_EXPECT_SKILLS: 'skill://canary/sample/SKILL.md' };
  for (const transport of ['http', 'stdio', 'proxy']) {
    const receipt = await qualifyLocalSkills({ ...env, MCP_SMOKE_TRANSPORT: transport });
    assert.equal(receipt.ok, true); assert.equal(receipt.candidateSha, candidate);
    assert.equal(receipt.localGate, 'NOT_EXERCISED', 'hermetic tests must not certify Desktop');
    assert.equal(receipt.mutationCalls, 0); assert.equal(receipt.skills.verified, 1);
    assert.equal(receipt.skills.resources, 2); assert.equal(receipt.sourceAndConfigUnchanged, true);
    assert.equal(receipt.sourceProjection.files, 1);
    assert.ok(!JSON.stringify(receipt).includes(bearer));
    assert.ok(!JSON.stringify(receipt).includes(sandbox));
    assert.ok(!JSON.stringify(receipt).includes(backend.root));
  }
  await assert.rejects(() => qualifyLocalSkills({ ...env, MCP_SMOKE_TRANSPORT: 'http', MCP_SMOKE_REQUIRE_LIVE: 'true' }));
  await assert.rejects(() => qualifyLocalSkills({ ...env, MCP_SMOKE_EXPECTED_SHA: '0'.repeat(40) }));
  const before = await snapshotVaultDocuments(backend.root);
  const sentinel = path.join(backend.root, 'Sentinel.md'); const original = await readFile(sentinel);
  await writeFile(sentinel, 'Changed fixture');
  assert.notDeepEqual(await snapshotVaultDocuments(backend.root), before);
  await writeFile(sentinel, original);
  assert.deepEqual(await snapshotVaultDocuments(backend.root), before);
  console.log('PASS: reusable local canary exercised over real HTTP/stdio/proxy, digest corruption rejected, source drift detected, wrong SHA/live proof refused');
} finally { await backend?.close(); await rm(sandbox, { recursive: true, force: true }); }
