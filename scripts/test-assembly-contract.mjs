import assert from 'node:assert/strict';
import fs from 'node:fs';
import yaml from 'js-yaml';
const hasPR=on=>Array.isArray(on)?on.includes('pull_request'):on&&typeof on==='object'&&Object.hasOwn(on,'pull_request');
let count=0;
for(const name of fs.readdirSync('.github/workflows')) {
  const doc=yaml.load(fs.readFileSync('.github/workflows/'+name,'utf8'));
  if(!hasPR(doc?.on))continue;
  for(const job of Object.values(doc.jobs??{}))for(const step of job.steps??[]) {
    if(!step.uses?.startsWith('actions/checkout@'))continue;
    assert.ok(['${{ github.event.pull_request.head.sha || github.sha }}','${{ github.event.pull_request.head.sha }}'].includes(step.with?.ref),name+' must test the PR head');
    count++;
  }
}
assert.ok(count>0);
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));
const root=JSON.parse(fs.readFileSync('package-lock.json','utf8')).packages[''];
for(const key of ['dependencies','optionalDependencies','devDependencies'])assert.deepEqual(root[key]??{},pkg[key]??{},'Lockfile root '+key);
for(const name of ['docs/cache-events.fr.md','docs/asset-import.fr.md']) {
  const text=fs.readFileSync(name,'utf8');assert.ok(!text.includes('\ufffd'),name+' has replacement characters');
  assert.ok(!/d\?j\?|r\?f\?renc|l\?abonnement/u.test(text),name+' has lossy French text');
}
console.log('PASS: '+count+' PR checkouts use the exact head; combined lockfile and French contracts are coherent');
