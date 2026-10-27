import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ObsidianNoteReplaceJournal, ObsidianNoteReplaceConcurrencyError } from '../dist/services/operations/obsidianNoteReplaceJournal.js';

const root = mkdtempSync(path.join(tmpdir(), 'journal-retention-'));
const db = path.join(root, 'journal.sqlite');
let now = Date.parse('2026-01-01T00:00:00Z');
const opts = { now: () => now, plannedRetentionMs: 1000, terminalRetentionMs: 2000, purgeIntervalMs: 1, executionLeaseMs: 500 };
const a = new ObsidianNoteReplaceJournal(db, opts);
const b = new ObsidianNoteReplaceJournal(db, opts);
function create(key) { return a.create({idempotencyKey:key, requestDigest:key, path:'a.md', beforeSha256:'before', afterSha256:'after', nextContent:'secret', bindingFingerprint:'binding'}); }
try {
  const planned = create('planned');
  const active = a.transition(create('active').operationId, ['planned'], 'applying');
  const unknown = a.transition(create('unknown').operationId, ['planned'], 'outcome_unknown');
  now += 1001;
  const expired = b.get(planned.operationId);
  assert.equal(expired.status, 'expired');
  assert.equal(expired.nextContent, '');
  assert.equal(expired.afterSha256, 'after');
  assert.throws(() => a.transition(planned.operationId, ['planned'], 'applying'), ObsidianNoteReplaceConcurrencyError);
  assert.notEqual(b.get(active.operationId).status, 'expired');
  assert.equal(b.get(unknown.operationId).status, 'outcome_unknown');
  const inspect = new DatabaseSync(db);
  assert.equal(inspect.prepare('SELECT count(*) AS n FROM obsidian_note_replace_runtime_leases WHERE expires_at <= ?').get(new Date(now).toISOString()).n, 0);
  inspect.close();
  a.close(); b.close();
  const reopened = new ObsidianNoteReplaceJournal(db, opts);
  assert.equal(reopened.get(planned.operationId).status, 'expired');
  now += 2001;
  assert.equal(reopened.get(planned.operationId), undefined);
  assert.equal(reopened.get(unknown.operationId).status, 'outcome_unknown');
  reopened.close();
  console.log('PASS: planned expiration fences apply, survives restart, purges terminal receipts and expired leases while preserving uncertain operations');
} finally { try { a.close(); b.close(); } catch {} rmSync(root, {recursive:true, force:true}); }
