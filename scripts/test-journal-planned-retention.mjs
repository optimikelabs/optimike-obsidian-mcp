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
  const preservedDb = path.join(root, 'preserved.sqlite');
  const preserveOpts = { ...opts, plannedRetentionMs: 0 };
  const preserved = new ObsidianNoteReplaceJournal(preservedDb, preserveOpts);
  const oldPlan = preserved.create({idempotencyKey:'historical', requestDigest:'historical', path:'a.md', beforeSha256:'before', afterSha256:'after', nextContent:'secret', bindingFingerprint:'binding'});
  preserved.close();
  const beforeDb = new DatabaseSync(preservedDb);
  const beforeRow = beforeDb.prepare('SELECT status, updated_at, payload_json FROM obsidian_note_replace_plans WHERE operation_id = ?').get(oldPlan.operationId);
  beforeDb.close();
  now += 10 * 365 * 24 * 60 * 60 * 1000;
  const afterRestart = new ObsidianNoteReplaceJournal(preservedDb, preserveOpts);
  assert.equal(afterRestart.get(oldPlan.operationId).status, 'planned');
  afterRestart.close();
  const afterDb = new DatabaseSync(preservedDb);
  assert.deepEqual(afterDb.prepare('SELECT status, updated_at, payload_json FROM obsidian_note_replace_plans WHERE operation_id = ?').get(oldPlan.operationId), beforeRow);
  afterDb.close();
  console.log('PASS: planned expiration fences apply, survives restart, purges terminal receipts and expired leases while preserving uncertain operations');
} finally { try { a.close(); b.close(); } catch {} rmSync(root, {recursive:true, force:true}); }

const proposalRoot = mkdtempSync(path.join(tmpdir(), 'proposal-retention-'));
const proposalDb = path.join(proposalRoot, 'journal.sqlite');
const proposalOpts = { ...opts, proposalConflictRetentionMs: 3000, proposalTraceRetentionMs: 7000 };
const proposals = new ObsidianNoteReplaceJournal(proposalDb, proposalOpts);
function proposalPlan(id) {
  const identity = {
    id, intentDigest: `intent:${id}`, publicIdempotencyKey: `proposal:${id}`,
    path: 'proposal.md', beforeSha256: 'before', bindingFingerprint: 'binding',
  };
  const input = {
    path: identity.path, beforeSha256: identity.beforeSha256, bindingFingerprint: identity.bindingFingerprint,
    idempotencyKey: `child:${id}`, requestDigest: 'request',
    afterSha256: 'after', nextContent: 'private patch',
    projection: { contractVersion: 1, kind: 'obsidian.text.patch', publicIdempotencyKey: identity.publicIdempotencyKey, intentDigest: identity.intentDigest },
  };
  const reference = (plan) => ({ planRef: `text:${plan.operationId}`, planDigest: `seal:${plan.operationId}` });
  return { input, identity, reference };
}
try {
  const rollback = proposalPlan('rollback');
  const failAssociation = new DatabaseSync(proposalDb);
  try {
    failAssociation.exec(`CREATE TRIGGER reject_proposal BEFORE INSERT ON obsidian_text_patch_proposals
      WHEN NEW.id = 'rollback' BEGIN SELECT RAISE(ABORT, 'association rejected'); END`);
    assert.throws(() => proposals.createTextPatchProposalPlan(rollback.input, rollback), /association rejected/u);
    assert.equal(proposals.getByIdempotencyKey(rollback.input.idempotencyKey), undefined);
    assert.equal(proposals.getTextPatchProposal(rollback.identity.id), undefined);
  } finally {
    failAssociation.exec('DROP TRIGGER reject_proposal');
    failAssociation.close();
  }

  const stale = proposalPlan('conflict');
  proposals.recordTextPatchProposalConflict(stale.identity);
  assert.equal(proposals.getTextPatchProposal(stale.identity.id).terminalStatus, 'conflict');
  const applied = proposalPlan('applied');
  const appliedPlan = proposals.createTextPatchProposalPlan(applied.input, applied);
  const applying = proposals.transition(appliedPlan.operationId, ['planned'], 'applying');
  proposals.transition(appliedPlan.operationId, ['applying'], 'committed', undefined, applying.executionOwner.attemptId);
  const inactive = proposalPlan('expires');
  const expires = proposals.createTextPatchProposalPlan(inactive.input, inactive);
  const uncertain = proposalPlan('uncertain');
  const uncertainPlan = proposals.createTextPatchProposalPlan(uncertain.input, uncertain);
  proposals.transition(uncertainPlan.operationId, ['planned'], 'outcome_unknown');

  now += 1001;
  assert.equal(proposals.get(expires.operationId).status, 'expired');
  now += 2001;
  assert.equal(proposals.getTextPatchProposal(stale.identity.id), undefined);
  assert.equal(proposals.get(appliedPlan.operationId), undefined);
  assert.equal(proposals.get(expires.operationId), undefined);
  for (const [proposal, plan, status] of [[applied, appliedPlan, 'committed'], [inactive, expires, 'expired']]) {
    const trace = proposals.getTextPatchProposal(proposal.identity.id);
    assert.deepEqual({ ...trace }, {
      ...proposal.identity, operationId: plan.operationId,
      ...proposal.reference(plan), terminalStatus: status,
    });
    assert.throws(() => proposals.createTextPatchProposalPlan(proposal.input, proposal), /already bound/u);
  }
  now += 5001;
  assert.equal(proposals.getTextPatchProposal(applied.identity.id), undefined);
  assert.equal(proposals.getTextPatchProposal(inactive.identity.id), undefined);
  assert.notEqual(proposals.createTextPatchProposalPlan(inactive.input, inactive).operationId, expires.operationId);
  assert.equal(proposals.getTextPatchProposal(uncertain.identity.id).operationId, uncertainPlan.operationId);
  assert.equal(proposals.get(uncertainPlan.operationId).status, 'outcome_unknown');
  console.log('PASS: association rollback leaves no plan, terminal traces outlive payloads and expire on their own schedule, and unresolved traces survive.');
} finally {
  proposals.close();
  rmSync(proposalRoot, { recursive: true, force: true });
}
