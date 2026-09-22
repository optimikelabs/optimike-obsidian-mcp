import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';

const required = [
  'docs/mcp-skills.md', 'docs/mcp-skills-local.md', 'docs/mcp-skills-CHECKPOINT.md',
  'scripts/smoke-mcp-skills-local.mjs', '.github/workflows/mcp-skills.yml',
];
const tests = ['source-snapshot', 'validation', 'registry', 'protocol', 'runtime', 'repo', 'smoke', 'readiness-contract'];
const forbidden = [
  '.github/workflows/mcp-skills-import-once.yml', 'docs/.online-skills-runtime.patch',
  '.github/workflows/mcp-2026-import.yml', '.github/workflows/mcp-2026-qualification.yml',
  '.github/workflows/mcp-online-snapshot.yml',
];
const names = [...required, ...tests.map(name => `scripts/test-skills-${name}.mjs`), ...forbidden];
const actual = new Map(names.filter(name => existsSync(name)).map(name => [name, readFileSync(name, 'utf8')]));
function validate(files) {
  for (const name of required) assert.ok(files.has(name), `Missing durable handoff: ${name}`);
  for (const name of tests) assert.ok(files.has(`scripts/test-skills-${name}.mjs`));
  for (const name of forbidden) assert.ok(!files.has(name), `Temporary online transport remains: ${name}`);
  const workflow = parse(files.get('.github/workflows/mcp-skills.yml'));
  assert.equal(workflow.permissions.contents, 'read');
  const job = workflow.jobs.skills;
  assert.deepEqual(job.strategy.matrix.os, ['ubuntu-latest', 'windows-latest']);
  assert.equal(job.steps.find(step => step.uses?.startsWith('actions/checkout@'))?.with?.ref, '${{ github.event.pull_request.head.sha }}');
  const commands = job.steps.map(step => step.run).filter(Boolean);
  for (const name of tests) assert.ok(commands.includes(`node scripts/test-skills-${name}.mjs`), `Missing Skills gate: ${name}`);
  const checkpoint = files.get('docs/mcp-skills-CHECKPOINT.md');
  assert.ok(checkpoint.includes('PR #103') && checkpoint.includes('PR #104'));
  assert.ok(checkpoint.includes('remote branch ref'));
  assert.ok(!checkpoint.includes('implementation NOT_DONE'));
  assert.ok(files.get('docs/mcp-skills-local.md').includes('MCP_SMOKE_EXPECTED_SHA'));
}
validate(actual);
let negatives = 0;
for (const name of required) {
  const altered = new Map(actual); altered.delete(name);
  assert.throws(() => validate(altered)); negatives++;
}
for (const name of forbidden) {
  const altered = new Map(actual); altered.set(name, 'temporary recipe');
  assert.throws(() => validate(altered)); negatives++;
}
for (const name of tests) {
  const altered = new Map(actual);
  altered.set('.github/workflows/mcp-skills.yml', altered.get('.github/workflows/mcp-skills.yml').replace(`      - run: node scripts/test-skills-${name}.mjs\n`, ''));
  assert.throws(() => validate(altered)); negatives++;
}
console.log(`PASS: durable two-PR handoff, exact-head Windows/Linux gates and ${negatives} negative recovery checks`);
