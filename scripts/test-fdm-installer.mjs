import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runFdmInstaller, buildFdmCompletionPatch } from './install-fdm-completion.mjs';

test('installer refuses unsupported FDM assets without modifying files or creating backups', () => {
  const temp = mkdtempSync(path.join(os.tmpdir(), 'fdm-installer-'));
  try {
    const vault = path.join(temp, 'vault'), dir = path.join(vault, '.obsidian/plugins/frontmatter-date-manager');
    mkdirSync(dir, { recursive: true });
    const main = path.join(dir, 'main.js'), manifest = path.join(dir, 'manifest.json'), data = path.join(dir, 'data.json');
    writeFileSync(main, 'unsupported fixture'); writeFileSync(data, '{"enabled":true}');
    writeFileSync(manifest, '{"version":"1.2.1"}');
    assert.throws(() => runFdmInstaller(['plan', '--vault', vault]), /Only the audited FDM/);
    writeFileSync(manifest, '{"version":"1.6.0"}');
    const before = [main, manifest, data].map(file => readFileSync(file));
    for (const command of ['plan', 'install']) {
      assert.throws(() => runFdmInstaller([command, '--vault', vault, '--backup-root', path.join(temp, 'backups'), '--apply', '--confirm-obsidian-closed']), /Unknown FDM build/);
    }
    assert.deepEqual([main, manifest, data].map(file => readFileSync(file)), before);
    assert.deepEqual(readdirSync(temp), ['vault']);
    assert.throws(() => buildFdmCompletionPatch(Buffer.from('tampered')), /Unknown FDM build/);
  } finally { rmSync(temp, { recursive: true, force: true }); }
});

test('installer requires explicit scope and rejects ambiguous or incomplete CLI inputs', () => {
  for (const args of [[], ['install'], ['plan', '--vault'], ['plan', '--unknown'], ['plan', '--vault', 'a', '--vault', 'b']]) {
    assert.throws(() => runFdmInstaller(args), assert.AssertionError);
  }
  assert.throws(() => runFdmInstaller(['rollback', '--receipt', 'not-read-without-apply']), /Rollback requires/);
});
