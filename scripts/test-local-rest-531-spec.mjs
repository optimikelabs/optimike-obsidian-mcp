import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import yaml from 'js-yaml';

const directory = new URL('../docs/obsidian-api/', import.meta.url);
const raw = readFileSync(new URL('obsidian_rest_api_spec.yaml', directory));
const json = readFileSync(new URL('obsidian_rest_api_spec.json', directory), 'utf8');
const source = JSON.parse(readFileSync(new URL('source.json', directory), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const gitBlob = (bytes) => createHash('sha1')
  .update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');

function verify(bytes, text, provenance) {
  assert.equal(provenance.repository, 'coddingtonbear/obsidian-local-rest-api');
  assert.equal(provenance.tag, '5.3.1');
  assert.equal(provenance.commit, '17a9cfd9ff5dd0156b694bf9b13ab36c786b29da');
  assert.equal(provenance.path, 'docs/openapi.yaml');
  assert.equal(provenance.blob, 'f8976e8add8a4cafab839a33a3cf6ff6c2af53ee');
  assert.equal(gitBlob(bytes), provenance.blob, 'snapshot must equal pinned upstream blob');
  assert.equal(sha256(bytes), provenance.sha256);
  const spec = yaml.load(bytes.toString('utf8'));
  assert.deepEqual(JSON.parse(text), spec, 'JSON must be an exact structural projection');
  assert.equal(spec.components.schemas.PatchInstruction.additionalProperties, false);
  assert.deepEqual(spec.components.schemas.PatchInstruction.required,
    ['targetType', 'target', 'operation']);
  assert.equal(spec.paths['/vault/{filename}'].patch.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/PatchInstruction');
  assert.match(spec.components.schemas.PatchInstruction.properties.content.description, /relative/);
  assert.equal(Object.keys(spec.paths).some(p => p.startsWith('/periodic/')), false);
  assert.ok(spec.paths['/events/{emitter}/{event}/'].post.responses['201']);
  assert.ok(spec.paths['/events/{emitter}/{event}/{subscriptionId}/'].get);
  assert.ok(spec.paths['/openapi.json'].get);
  return spec;
}

test('pinned upstream specification and JSON projection agree', () => verify(raw, json, source));
test('altered bytes cannot retain upstream provenance', () => {
  assert.throws(() => verify(Buffer.concat([raw, Buffer.from('\n')]), json, source));
});
test('a locally recomputed digest cannot bless another upstream blob', () => {
  const changed = Buffer.concat([raw, Buffer.from('\n')]);
  assert.throws(() => verify(changed, json, {...source, sha256: sha256(changed)}));
});
test('JSON contract drift is rejected', () => {
  const changed = JSON.parse(json);
  delete changed.paths['/events/{emitter}/{event}/'];
  assert.throws(() => verify(raw, JSON.stringify(changed), source));
});
test('version or commit substitution is rejected', () => {
  assert.throws(() => verify(raw, json, {...source, tag: '5.1.0'}));
  assert.throws(() => verify(raw, json, {...source, commit: '0'.repeat(40)}));
});
