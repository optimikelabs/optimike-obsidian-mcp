import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExternalRootsService } from '../dist/services/externalRootsService.js';
import { SkillRegistry } from '../dist/services/skills/skillRegistry.js';
import { validateSkillFrontmatter, validateSkillReferences } from '../dist/services/skills/skillValidation.js';

const repo = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const name = 'elysia-task-gouverneur';
const prefix = `skill://repo.skills/${name}/`;
const expected = [
  'SKILL.md', 'references/admission-p90-j.md', 'references/audits-et-triage.md',
  'references/contrat-de-sortie.md', 'references/cycle-de-vie-projet.md',
  'references/operations-ponctuelles.md', 'references/runtime-et-mutations.md',
  'references/sante-et-performance.md',
].sort();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sandbox = await mkdtemp(path.join(os.tmpdir(), 'optimike-repo-skill-'));
const profilePath = path.join(repo, 'profiles/elysia-tasks/v1/profile.json');
const profileBefore = sha(await readFile(profilePath));
try {
  const rootsFile = path.join(sandbox, 'roots.json');
  await writeFile(rootsFile, JSON.stringify({ version: 1, roots: [{
    id: 'repo.skills', path: path.join(repo, 'profiles/elysia-tasks/skills'),
    capabilities: ['visible', 'readable'],
  }] }));
  const roots = await ExternalRootsService.fromConfigFile(rootsFile);
  const before = await roots.readSkillDirectorySnapshot('repo.skills', name);
  assert.deepEqual(before.files.map(file => file.path).sort(), expected);
  const skill = before.files.find(file => file.path === 'SKILL.md');
  const frontmatter = validateSkillFrontmatter(skill.bytes, name);
  validateSkillReferences(before.files);
  assert.ok(Object.values(frontmatter.metadata).every(value => typeof value === 'string'));
  assert.equal(frontmatter.metadata.profile_id, 'elysia.tasks');
  assert.equal(frontmatter.metadata.reference_gate, 'true');
  assert.equal(frontmatter.metadata.profile_schema_version, '1');
  const text = skill.bytes.toString('utf8');
  assert.ok(text.includes('contrat externe'));
  assert.ok(text.includes('profiles/elysia-tasks/v1/profile.json'));
  assert.ok(!text.includes('../../v1/profile.json'));
  for (const invariant of ['expectedRevision', 'idempotencyKey', 'validation humaine', 'operon_get_configuration', 'operon_status']) {
    assert.ok(text.includes(invariant), `lost task governance: ${invariant}`);
  }
  const registry = new SkillRegistry(roots, { version: 1, skills: [{ rootId: 'repo.skills', path: name }] }, 'full');
  const listing = await registry.list();
  assert.equal(listing.skills.length, 1);
  const entry = listing.skills[0];
  assert.deepEqual((await registry.get(entry.uri)).skill, entry);
  assert.deepEqual(entry.frontmatter, frontmatter);
  assert.deepEqual(entry.resources.map(resource => resource.uri.slice(prefix.length)).sort(), expected);
  for (const resource of entry.resources) {
    assert.ok(resource.uri.startsWith(prefix));
    assert.ok(!resource.uri.includes('profile.json'));
    const response = await registry.read(resource.uri);
    const content = response.contents[0];
    const bytes = content.text === undefined ? Buffer.from(content.blob, 'base64') : Buffer.from(content.text);
    assert.equal(resource.digest, `sha256:${sha(bytes)}`);
    assert.equal(resource.size, bytes.length);
  }
  await assert.rejects(() => registry.read(prefix + '../../v1/profile.json'));
  await assert.rejects(() => registry.read(prefix + 'profile.json'));
  const after = await roots.readSkillDirectorySnapshot('repo.skills', name);
  assert.deepEqual(after.files.map(file => [file.path, sha(file.bytes)]), before.files.map(file => [file.path, sha(file.bytes)]));
  assert.equal(sha(await readFile(profilePath)), profileBefore);
  console.log('PASS: actual repository skill, eight complete raw-byte resources, external profile excluded and all sources unchanged');
} finally {
  await rm(sandbox, { recursive: true, force: true });
}
