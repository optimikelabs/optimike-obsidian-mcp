#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, realpathSync, lstatSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const FDM_ORIGINAL_SHA256 = 'ab07d62224b415cba7d978e2e8a87a27dac568842dc7f137a381925fc9f315fb';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8'));
function regular(file) { assert.ok(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink(), 'Expected a regular managed file'); }
function directory(dir) { assert.equal(realpathSync(dir).toLowerCase(), path.resolve(dir).toLowerCase(), 'Linked directories are refused'); }
function assets(vault) {
  vault = path.resolve(vault); directory(vault);
  let dir = vault;
  for (const part of ['.obsidian', 'plugins', 'frontmatter-date-manager']) { dir = path.join(dir, part); directory(dir); }
  const main = path.join(dir, 'main.js'), manifest = path.join(dir, 'manifest.json'), data = path.join(dir, 'data.json');
  regular(main); regular(manifest); if (existsSync(data)) regular(data);
  assert.equal(json(manifest).version, '1.6.0', 'Only the audited FDM 1.6.0 build is supported');
  return { vault, main, manifest, data, metadata: { manifest: hash(readFileSync(manifest)), data: existsSync(data) ? hash(readFileSync(data)) : null } };
}
export function buildFdmCompletionPatch(before) {
  assert.equal(hash(before), FDM_ORIGINAL_SHA256, 'Unknown FDM build; no patch is permitted');
  let source = before.toString('utf8');
  const eol = '\r\n';
  const edits = [
    ['    await this.loadSettings();' + eol + '    this.setupOnEditHandler();', '    await this.loadSettings();' + eol + '    installFdmSettlementSignal(this);' + eol + '    this.setupOnEditHandler();'],
    ['        }, MODIFY_DEBOUNCE_MS);' + eol + '        this.modifyTimers.set(file.path, timer);', '        }, this.optimikeSettlement?.modifyDebounceMs(file) ?? MODIFY_DEBOUNCE_MS);' + eol + '        this.modifyTimers.set(file.path, timer);'],
  ];
  for (const [old, replacement] of edits) { assert.equal(source.split(old).length, 2, 'Audited anchor mismatch'); source = source.replace(old, replacement); }
  const signal = readFileSync(path.join(root, 'plugins/fdm-settlement/signal.mjs'), 'utf8').replace(/\r\n/g, '\n').replace('export function installFdmSettlementSignal', 'function installFdmSettlementSignal');
  return Buffer.from(source + '\n' + signal, 'utf8');
}
function atomic(file, bytes) {
  const temporary = file + '.optimike-' + randomUUID();
  try { writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 }); renameSync(temporary, file); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
function saveReceipt(file, receipt) { atomic(file, JSON.stringify(receipt, null, 2) + '\n'); }
export function runFdmInstaller(argv) {
  const [command, ...args] = argv; assert.ok(['plan', 'install', 'rollback'].includes(command), 'Use plan, install or rollback');
  const opts = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i]; assert.ok(['--vault', '--backup-root', '--receipt', '--apply', '--confirm-obsidian-closed'].includes(key), 'Unknown option');
    assert.ok(!(key in opts), 'Duplicate option');
    if (['--apply', '--confirm-obsidian-closed'].includes(key)) opts[key] = true;
    else { const value = args[++i]; assert.ok(value && !value.startsWith('--'), 'Missing option value'); opts[key] = value; }
  }
  if (command === 'rollback') {
    assert.ok(opts['--receipt'] && opts['--apply'] && opts['--confirm-obsidian-closed'], 'Rollback requires receipt, apply and closed-vault attestation');
    const receiptFile = path.resolve(opts['--receipt']); regular(receiptFile); const receipt = json(receiptFile);
    assert.equal(receipt.schemaVersion, 1); assert.ok(['applying', 'committed', 'rolled_back'].includes(receipt.state));
    const a = assets(receipt.vault); assert.deepEqual(a.metadata, receipt.metadata, 'Settings/manifest drift; refusing rollback');
    const backup = path.join(path.dirname(receiptFile), 'main.before.js'); regular(backup); const before = readFileSync(backup);
    assert.equal(hash(before), FDM_ORIGINAL_SHA256, 'Backup must be the audited original');
    const current = hash(readFileSync(a.main)); assert.ok(current === receipt.afterSha256 || current === FDM_ORIGINAL_SHA256, 'Concurrent asset change; refusing rollback');
    if (current !== FDM_ORIGINAL_SHA256) atomic(a.main, before);
    assert.equal(hash(readFileSync(a.main)), FDM_ORIGINAL_SHA256); receipt.state = 'rolled_back'; saveReceipt(receiptFile, receipt);
    return { state: receipt.state, receipt: receiptFile };
  }
  assert.ok(opts['--vault'], 'An explicit vault is required'); const a = assets(opts['--vault']);
  const before = readFileSync(a.main), after = buildFdmCompletionPatch(before);
  const planned = { state: 'planned', plugin: 'frontmatter-date-manager', version: '1.6.0', beforeSha256: hash(before), afterSha256: hash(after), metadataUnchanged: true };
  if (command === 'plan') { assert.ok(!opts['--apply'], 'plan is read-only'); return planned; }
  assert.ok(opts['--apply'] && opts['--confirm-obsidian-closed'] && opts['--backup-root'], 'Install requires apply, closed-vault attestation and an external backup root');
  const backupRoot = path.resolve(opts['--backup-root']); assert.ok(!backupRoot.toLowerCase().startsWith(a.vault.toLowerCase() + path.sep) && backupRoot.toLowerCase() !== a.vault.toLowerCase(), 'Backups must be outside the vault');
  mkdirSync(backupRoot, { recursive: true }); directory(backupRoot);
  const backupDir = path.join(backupRoot, 'fdm-completion-' + randomUUID()); mkdirSync(backupDir);
  writeFileSync(path.join(backupDir, 'main.before.js'), before, { flag: 'wx', mode: 0o600 });
  const receiptFile = path.join(backupDir, 'receipt.json'); const receipt = { schemaVersion: 1, ...planned, vault: a.vault, metadata: a.metadata, state: 'applying' };
  saveReceipt(receiptFile, receipt);
  console.error('FDM backup receipt: ' + receiptFile);
  assert.equal(hash(readFileSync(a.main)), receipt.beforeSha256, 'Concurrent asset change'); assert.deepEqual(assets(a.vault).metadata, a.metadata, 'Metadata drift');
  atomic(a.main, after); assert.equal(hash(readFileSync(a.main)), receipt.afterSha256); assert.deepEqual(assets(a.vault).metadata, a.metadata);
  receipt.state = 'committed'; saveReceipt(receiptFile, receipt); return { state: receipt.state, receipt: receiptFile, afterSha256: receipt.afterSha256 };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(runFdmInstaller(process.argv.slice(2)))); }
  catch (error) { console.error(error instanceof assert.AssertionError ? error.message.split('\n')[0] : 'FDM installation failed; inspect the recorded backup receipt before recovery'); process.exitCode = 1; }
}
