import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ObsidianNoteReplaceOperationAdapter, markAtomicWritePreDispatchError } from "../dist/services/operations/obsidianNoteReplaceOperationAdapter.js";
import { ObsidianNoteReplaceJournal } from "../dist/services/operations/obsidianNoteReplaceJournal.js";
import { BaseErrorCode, McpError } from "../dist/types-global/errors.js";
function sha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}
class FakeAtomicWriteBackend {
  bindingFingerprint = sha256("fixture-vault-instance");
  path = "Fixture/Note.md";
  reportedPath = undefined;
  content = "before";
  replaceCalls = 0;
  failBeforeWriteOnce = false;
  rejectBeforeWriteOnce = false;
  loseResponseAfterWriteOnce = false;
  afterStatus = undefined;
  afterRead = undefined;
  beforeWrite = undefined;
  afterWriteBeforeReturn = undefined;
  settlement = undefined;
  protection = undefined;

  defaultProtection() {
    return {
      contractVersion: 1,
      frontmatterDateProperties: {
        integrations: (
          this.settlement?.modifiedTimeFrontmatter.integrations ?? []
        ).map((integration) => ({
          pluginId: integration.pluginId,
          modifiedPropertyName: integration.propertyName,
        })),
      },
    };
  }

  async status() {
    const response = {
      ok: true,
      contractVersion: 1,
      plugin: { id: "obsidian-atomic-write-bridge", version: "0.2.0" },
      backend: {
        kind: "obsidian-vault-process",
        bindingFingerprint: this.bindingFingerprint,
        atomicCas: true,
        writeEnabled: true,
      },
      limits: { markdownOnly: true },
      ...(this.settlement ? { settlement: this.settlement } : {}),
      protection: this.protection ?? this.defaultProtection(),
    };
    if (this.afterStatus) {
      const afterStatus = this.afterStatus;
      this.afterStatus = undefined;
      await afterStatus();
    }
    return response;
  }

  async read(payload) {
    assert.equal(payload.path, this.path);
    const response = {
      ok: true,
      contractVersion: 1,
      path: this.reportedPath ?? this.path,
      content: this.content,
      sha256: sha256(this.content),
      size: Buffer.byteLength(this.content, "utf8"),
      bindingFingerprint: this.bindingFingerprint,
    };
    if (this.afterRead) {
      const afterRead = this.afterRead;
      this.afterRead = undefined;
      await afterRead();
    }
    return response;
  }

  async replace(payload) {
    this.replaceCalls += 1;
    if (this.rejectBeforeWriteOnce) {
      this.rejectBeforeWriteOnce = false;
      throw new McpError(
        BaseErrorCode.FORBIDDEN,
        "Atomic note writes are disabled in the bridge settings.",
      );
    }
    if (payload.bindingFingerprint !== this.bindingFingerprint) {
      throw new McpError(BaseErrorCode.CONFLICT, "Fixture binding conflict.");
    }
    if (this.failBeforeWriteOnce) {
      this.failBeforeWriteOnce = false;
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        "Fixture lost the request before the write.",
      );
    }
    if (this.beforeWrite) {
      const beforeWrite = this.beforeWrite;
      this.beforeWrite = undefined;
      await beforeWrite();
    }
    const beforeSha256 = sha256(this.content);
    if (beforeSha256 !== payload.expectedSha256) {
      throw new McpError(BaseErrorCode.CONFLICT, "Fixture hash conflict.");
    }
    this.content = payload.nextContent;
    const afterSha256 = sha256(this.content);
    const size = Buffer.byteLength(this.content, "utf8");
    if (this.afterWriteBeforeReturn) {
      await this.afterWriteBeforeReturn();
      this.afterWriteBeforeReturn = undefined;
    }
    if (this.loseResponseAfterWriteOnce) {
      this.loseResponseAfterWriteOnce = false;
      throw new McpError(
        BaseErrorCode.SERVICE_UNAVAILABLE,
        "Fixture lost the response after the write.",
      );
    }
    return {
      ok: true,
      contractVersion: 1,
      path: this.path,
      beforeSha256,
      afterSha256,
      size,
      bindingFingerprint: this.bindingFingerprint,
    };
  }
}

const root = mkdtempSync(path.join(os.tmpdir(), "optimike-deferred-"));
const journals = [];
let count = 0;
function fixture() {
  let now = Date.parse("2026-10-08T10:00:00Z");
  const backend = new FakeAtomicWriteBackend();
  backend.readCalls = 0;
  const read = backend.read.bind(backend);
  backend.read = async (...args) => {
    backend.readCalls++;
    return read(...args);
  };
  backend.content = "---\nmodification: 2026-10-08T09:00\n---\navant é\n";
  backend.settlement = {
    contractVersion: 1,
    modifiedTimeFrontmatter: {
      integrations: [
        {
          pluginId: "frontmatter-date-manager",
          propertyName: "modification",
          settlementObservationDelayMs: 37250,
        },
      ],
      utcOffsetMinutes: 0,
    },
  };
  const db = path.join(root, `${++count}.sqlite`);
  const options = {
    now: () => now,
    sleep: async () => {
      throw new Error("deferred must never sleep");
    },
  };
  let journal = new ObsidianNoteReplaceJournal(db, {
    now: options.now,
    executionLeaseMs: 120000,
  });
  journals.push(journal);
  let adapter = new ObsidianNoteReplaceOperationAdapter(
    backend,
    journal,
    undefined,
    options,
  );
  return {
    backend,
    get journal() {
      return journal;
    },
    get adapter() {
      return adapter;
    },
    advance: (ms) => {
      now += ms;
    },
    now: () => now,
    restart() {
      journal.close();
      journal = new ObsidianNoteReplaceJournal(db, {
        now: options.now,
        executionLeaseMs: 120000,
      });
      journals.push(journal);
      adapter = new ObsidianNoteReplaceOperationAdapter(
        backend,
        journal,
        undefined,
        options,
      );
    },
    async plan() {
      return adapter.plan({
        path: backend.path,
        nextContent: backend.content.replace("avant", "après"),
        idempotencyKey: "test",
      });
    },
  };
}
try {
  for (const scenario of ['complete','date','pending','wrong-token','wrong-path','wrong-binding','drift','probe-fails','restart']) {
    const f=fixture(), token='12345678-1234-4234-8234-123456789012';
    const originalReplace=f.backend.replace.bind(f.backend), originalRead=f.backend.read.bind(f.backend);
    f.backend.replace=async p=>({...await originalReplace(p),completionToken:token});
    const p=await f.plan();const applied=await f.adapter.apply(p.planRef,'test','deferred');assert.equal(applied.phase,'applying');
    f.advance(2100); if(scenario==='restart')f.restart();
    f.backend.read=async p=>{
      if(p.completionToken && scenario==='probe-fails')throw new Error('offline');
      const out=await originalRead(p);
      if(p.completionToken && true)out.completion={contractVersion:1,kind:'fdm-completion-v1',token:scenario==='wrong-token'?'87654321-1234-4234-8234-123456789012':token,epoch:'aaaaaaaa-1234-4234-8234-123456789012',generation:1,state:scenario==='pending'?'pending':'complete'};
      if(scenario==='wrong-path')out.path='Wrong.md';if(scenario==='wrong-binding')out.bindingFingerprint=sha256('other');return out;
    };
    if(scenario==='date')f.backend.content=f.backend.content.replace('2026-10-08T09:00','2026-10-08T10:00');
    if(scenario==='drift')f.backend.content+='unauthorized';
    const status=await f.adapter.status(p.planRef);
    if(['complete','date','restart'].includes(scenario)){
      assert.equal(status.outcome,'committed',scenario);assert.equal(status.afterProof.details.sha256,sha256(f.backend.content));
      assert.equal(status.afterProof.details.completionKind,'fdm-completion-v1');
      f.restart();assert.equal((await f.adapter.status(p.planRef)).afterProof.details.completionKind,'fdm-completion-v1');
      const replay=await f.adapter.apply(p.planRef,'test','deferred');assert.equal(replay.outcome,'committed');
    }else if(scenario==='drift')assert.equal(status.outcome,'outcome_unknown');
    else assert.equal(status.phase,'applying',scenario);
    if(scenario==='pending'){f.advance(40000);assert.equal((await f.adapter.status(p.planRef)).phase,'applying','Known pending effect after original delay');f.advance(300000);assert.equal((await f.adapter.status(p.planRef)).outcome,'outcome_unknown');assert.equal((await f.adapter.status(p.planRef)).outcome,'outcome_unknown');}
    assert.equal(f.backend.replaceCalls,1);
    assert.ok(!JSON.stringify(status).includes(token),'Private token/epoch must not leak (epoch is evidence, token must differ)');
  }
  for (const scenario of ['blocking-complete', 'blocking-date', 'blocking-pending', 'blocking-expired-token', 'blocking-probe-fails', 'blocking-drift', 'blocking-replay', 'blocking-concurrent-status', 'blocking-owner-interrupted']) {
    const f = fixture(), token = '12345678-1234-4234-8234-123456789012';
    const start = f.now(), originalReplace = f.backend.replace.bind(f.backend), originalRead = f.backend.read.bind(f.backend);
    f.backend.replace = async p => ({...await originalReplace(p), completionToken: token});
    f.backend.read = async p => {
      if (p.completionToken && scenario === 'blocking-probe-fails') throw new Error('offline');
      const out = await originalRead(p);
      if (p.completionToken && scenario !== 'blocking-expired-token') out.completion = {
        contractVersion: 1, kind: 'fdm-completion-v1', token,
        epoch: 'aaaaaaaa-1234-4234-8234-123456789012', generation: 1,
        state: scenario === 'blocking-pending' || f.now() - start < 750 ? 'pending' : 'complete',
      };
      return out;
    };
    const sleeps = [];
    f.adapter.options.sleep = async ms => {
      sleeps.push(ms); assert.ok(ms > 0 && ms <= 250); f.advance(ms);
      if (f.now() - start === 750) {
        if (scenario === 'blocking-date') f.backend.content = f.backend.content.replace('2026-10-08T09:00','2026-10-08T10:00');
        if (scenario === 'blocking-drift') f.backend.content += 'unauthorized';
        if (scenario === 'blocking-concurrent-status') await f.adapter.status(p.planRef);
        if (scenario === 'blocking-owner-interrupted') f.journal.transition(p.operationId, ['applying'], 'outcome_unknown', 'fixture interruption', f.journal.get(p.operationId).executionOwner.attemptId);
      }
    };
    const p = await f.plan();
    if (scenario === 'blocking-replay') {
      await f.adapter.apply(p.planRef, 'test', 'deferred'); f.restart();
      f.adapter.options.sleep = async ms => { sleeps.push(ms); f.advance(ms); };
    }
    const applied = await f.adapter.apply(p.planRef, 'test', 'verified');
    if (['blocking-pending','blocking-probe-fails'].includes(scenario)) {
      assert.equal(applied.phase, 'applying'); assert.equal(f.now() - start, 37250);
      f.advance(300000); assert.equal((await f.adapter.status(p.planRef)).outcome, 'outcome_unknown');
    } else if (scenario === 'blocking-drift' || scenario === 'blocking-owner-interrupted') {
      assert.equal(applied.outcome, 'outcome_unknown'); assert.equal(f.now() - start, 750);
    } else {
      assert.equal(applied.outcome, 'committed');
      assert.equal(f.now() - start, scenario === 'blocking-expired-token' ? 37250 : 750);
      assert.equal(applied.afterProof.details.completionKind, scenario === 'blocking-expired-token' ? undefined : 'fdm-completion-v1');
      assert.equal((await f.adapter.apply(p.planRef, 'test', 'verified')).outcome, 'committed');
    }
    assert.equal(f.backend.replaceCalls, 1, scenario); assert.ok(sleeps.length);
  }
  console.log('PASS FDM completion: deferred and blocking proofs, bounded pending, restart/replay, concurrent status, date/drift, invalid signals and legacy fallback');
} finally { for(const journal of journals)journal.close();rmSync(root,{recursive:true,force:true}); }
