import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import yaml from 'js-yaml';

const directory = new URL('../docs/obsidian-api/', import.meta.url);
const raw = readFileSync(new URL('obsidian_rest_api_spec.yaml', directory));
const json = readFileSync(new URL('obsidian_rest_api_spec.json', directory), 'utf8');
const source = JSON.parse(readFileSync(new URL('source.json', directory), 'utf8'));
const association = JSON.parse(readFileSync(new URL('provenance.json', directory), 'utf8'));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const gitBlob = (bytes) => createHash('sha1')
  .update(Buffer.from('blob ' + bytes.length + '\0')).update(bytes).digest('hex');

function verifyAssociation(proof, bytes) {
  const getObject = (name, type, sha) => {
    const object = proof.objects[name];
    assert.equal(object.type, type);
    assert.equal(object.sha, sha);
    const raw = Buffer.from(object.base64, 'base64');
    assert.equal(raw.toString('base64'), object.base64);
    assert.equal(createHash('sha1').update(Buffer.from(type + ' ' + raw.length + '\0')).update(raw).digest('hex'), sha);
    return raw;
  };
  const tag = getObject('tag', 'tag', '7779963db3dfdf1e95f5a23d8475b86393973615').toString('utf8');
  assert.ok(tag.startsWith('object 17a9cfd9ff5dd0156b694bf9b13ab36c786b29da\ntype commit\ntag 5.3.1\n'));
  const commit = getObject('commit', 'commit', '17a9cfd9ff5dd0156b694bf9b13ab36c786b29da').toString('utf8');
  const rootSha = /^tree ([a-f0-9]{40})\n/u.exec(commit)?.[1];
  assert.ok(rootSha);
  const entry = (tree, name) => {
    const found=[];let offset=0;
    while(offset<tree.length) {
      const separator=tree.indexOf(0,offset);assert.ok(separator>=offset && separator+21<=tree.length);
      const label=tree.subarray(offset,separator).toString('utf8');
      const space=label.indexOf(' ');assert.ok(space>0);
      if(label.slice(space+1)===name)found.push({mode:label.slice(0,space),sha:tree.subarray(separator+1,separator+21).toString('hex')});
      offset=separator+21;
    }
    assert.equal(found.length,1);return found[0];
  };
  const docs=entry(getObject('rootTree','tree',rootSha),'docs');assert.equal(docs.mode,'40000');
  const yamlFile=entry(getObject('docsTree','tree',docs.sha),'openapi.yaml');assert.equal(yamlFile.mode,'100644');
  assert.equal(yamlFile.sha,gitBlob(bytes));
}

function verify(bytes, text, provenance) {
  verifyAssociation(association, bytes);
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

test('commit-to-path association rejects substituted trees', () => {
  const wrong=structuredClone(association);wrong.objects.docsTree=wrong.objects.rootTree;
  assert.throws(()=>verifyAssociation(wrong,raw));
});
test('tag-to-commit association rejects altered raw objects', () => {
  const wrong=structuredClone(association);wrong.objects.commit.base64=Buffer.from('tree '+'0'.repeat(40)+'\n').toString('base64');
  assert.throws(()=>verifyAssociation(wrong,raw));
});


test('both compatibility triggers cover compiler and build dependencies', () => {
  const workflow = yaml.load(readFileSync(new URL('../.github/workflows/local-rest-compat.yml', import.meta.url), 'utf8'));
  for (const event of ['pull_request', 'push']) {
    for (const input of ['src/**', 'tsconfig.json', 'scripts/make-executable.mjs', 'package.json', 'package-lock.json', '.gitattributes']) {
      assert.ok(workflow.on[event].paths.includes(input), event + ' misses ' + input);
    }
  }
});

test('qualification workflow explicitly checks out the pull-request head', async () => {
  const fs = await import('node:fs');
  const yaml = (await import('js-yaml')).default;
  const flow = yaml.load(fs.readFileSync(new URL('../.github/workflows/local-rest-compat.yml', import.meta.url), 'utf8'));
  for (const job of Object.values(flow.jobs)) {
    const checkouts = job.steps.filter(step => step.uses?.startsWith('actions/checkout@'));
    assert.equal(checkouts.length, 1);
    assert.equal(checkouts[0].with?.ref, '${{ github.event.pull_request.head.sha || github.sha }}');
  }
});