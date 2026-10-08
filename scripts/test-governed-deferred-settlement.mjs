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
  for (const drift of ["none", "value", "outside", "body", "created"]) {
    const f = fixture();
    f.backend.content = f.backend.content.replace("---\navant", "création: 2026-08-01T09:00\nunknown: preserve\n---\navant");
    const nextContent = f.backend.content.replace("avant", "après").replace("---\naprès", 'bench_unicode: "élysia ✅"\n---\naprès');
    const intentDigest = sha256("combined-format-fixture");
    const p = await f.adapter.plan({path:f.backend.path,nextContent,idempotencyKey:"test",idempotencyIdentity:intentDigest,projection:{contractVersion:1,kind:"obsidian.text.patch",publicIdempotencyKey:"public",intentDigest,proof:{},frontmatterProof:{changedKeys:["bench_unicode"]}}});
    await f.adapter.apply(p.planRef,"test","deferred");
    f.restart(); f.advance(37250);
    f.backend.content = f.backend.content.replace("2026-10-08T09:00","2026-10-08T10:00").replace('bench_unicode: "élysia ✅"','bench_unicode: élysia ✅');
    if(drift==="value")f.backend.content=f.backend.content.replace("élysia ✅","concurrent");
    if(drift==="outside")f.backend.content=f.backend.content.replace("unknown: preserve",'unknown: "preserve"');
    if(drift==="body")f.backend.content=f.backend.content.replace("après","concurrent");
    if(drift==="created")f.backend.content=f.backend.content.replace("création: 2026-08-01T09:00","création: 2026-08-02T09:00");
    const final = await f.adapter.status(p.planRef);
    assert.equal(final.outcome,drift==="none"?"committed":"outcome_unknown");
    assert.equal(f.backend.replaceCalls,1);
    if(drift==="none"){
      assert.equal(final.afterProof.details.sha256,sha256(f.backend.content));
      assert.equal(final.afterProof.details.settlementAuthorizedFormatKeyCount,1);
      f.restart();const durable=await f.adapter.status(p.planRef);assert.equal(durable.afterProof.details.settlementAuthorizedFormatKeyCount,1);assert.equal(durable.outcome,"committed");
    }
  }
  for (const restart of [false, true]) {
    const f = fixture(),
      p = await f.plan();
    const r = await f.adapter.apply(p.planRef, "test", "deferred");
    assert.equal(r.phase, "applying");
    assert.equal(r.outcome, null);
    assert.equal(r.postflight.status, "pending");
    assert.equal(r.afterProof, undefined);
    assert.equal(r.postflight.reason, "modified_time_settlement");
    assert.equal(Date.parse(r.postflight.checkAfter), f.now() + 37250);
    assert.equal(f.backend.replaceCalls, 1);
    const reads = f.backend.readCalls;
    if (restart) f.restart();
    for (let i = 0; i < 5; i++) {
      assert.equal((await f.adapter.status(p.planRef)).phase, "applying");
      assert.equal(
        (await f.adapter.apply(p.planRef, "test", "deferred")).phase,
        "applying",
      );
      assert.equal(
        (await f.adapter.recover(p.planRef, "test", "deferred")).phase,
        "applying",
      );
    }
    assert.equal(
      f.backend.readCalls,
      reads,
      "polling before checkAfter must not reread the backend",
    );
    f.advance(37249);
    assert.equal((await f.adapter.status(p.planRef)).phase, "applying");
    f.advance(1);
    f.backend.content = f.backend.content.replace(
      "2026-10-08T09:00",
      "2026-10-08T10:00",
    );
    const done = await f.adapter.status(p.planRef);
    assert.equal(done.outcome, "committed");
    assert.equal(done.postflight.status, "verified");
    assert.equal(done.afterProof.details.sha256, sha256(f.backend.content));
    assert.equal(done.postflight.checkAfter, undefined);
    assert.equal(
      (await f.adapter.apply(p.planRef, "test", "deferred")).outcome,
      "committed",
    );
    assert.equal(f.backend.replaceCalls, 1);
  }
  {
    // concurrent drift after a successful CAS must not remain applying forever
    const f = fixture(),
      p = await f.plan();
    await f.adapter.apply(p.planRef, "test", "deferred");
    f.backend.content += "concurrent edit\n";
    f.advance(37250);
    assert.equal(
      (await f.adapter.status(p.planRef)).outcome,
      "outcome_unknown",
    );
    await f.adapter.recover(p.planRef, "test", "deferred");
    assert.equal(f.backend.replaceCalls, 1);
  }
  {
    const f = fixture(), p = await f.plan();
    f.backend.replace = async () => { throw markAtomicWritePreDispatchError(new McpError(BaseErrorCode.CONFLICT, "Trusted wrapper refused before dispatch.")); };
    const r = await f.adapter.apply(p.planRef, "test", "deferred");
    assert.equal(r.outcome, "conflict");
    assert.equal(r.postflight.checkAfter, undefined);
    assert.equal(f.backend.replaceCalls, 0);
  }
  {
    // A public error property cannot impersonate the private non-dispatch marker.
    const f = fixture(), p = await f.plan();
    f.backend.replace = async () => { throw new McpError(BaseErrorCode.CONFLICT, "Upstream conflict.", { preDispatch: true }); };
    const r = await f.adapter.apply(p.planRef, "test", "deferred");
    assert.equal(r.phase, "applying");
    assert.ok(r.postflight.checkAfter);
  }
  {
    // stale CAS conflict is certified once the same settlement window closes
    const f = fixture(),
      p = await f.plan();
    f.backend.content += "concurrent edit\n";
    const r = await f.adapter.apply(p.planRef, "test", "deferred");
    assert.equal(r.phase, "applying");
    f.restart();
    f.advance(37250);
    assert.equal((await f.adapter.status(p.planRef)).outcome, "conflict");
    assert.ok(f.backend.content.endsWith("concurrent edit\n"));
    assert.equal(f.backend.replaceCalls, 1);
  }
  for (const afterWrite of [false, true]) {
    const f = fixture(),
      p = await f.plan();
    if (afterWrite) f.backend.loseResponseAfterWriteOnce = true;
    else f.backend.failBeforeWriteOnce = true;
    const r = await f.adapter.apply(p.planRef, "test", "deferred");
    assert.equal(r.outcome, "outcome_unknown");
    assert.ok(r.postflight.checkAfter);
    await f.adapter.recover(p.planRef, "test", "deferred");
    assert.equal(f.backend.replaceCalls, 1);
    f.restart();
    f.advance(37250);
    if (afterWrite) {
      assert.equal((await f.adapter.status(p.planRef)).outcome, "committed");
    } else {
      const resumed = await f.adapter.recover(p.planRef, "test", "deferred");
      assert.equal(resumed.phase, "applying");
      assert.equal(f.backend.replaceCalls, 2);
      f.advance(37250);
      assert.equal((await f.adapter.status(p.planRef)).outcome, "committed");
    }
  }
  {
    // both public projections use the real runtime, MCP schemas and cache hook
    process.env.OBSIDIAN_API_KEY = "fixture-key";
    process.env.MCP_WRITE_MODE = "full";
    const { GovernedNoteReplaceRuntime } = await import(
      "../dist/mcp-server/tools/governedNoteReplaceTools/runtime.js"
    );
    const { registerGovernedTextPatchTools } = await import(
      "../dist/mcp-server/tools/governedTextPatchTools/registration.js"
    );
    const { registerGovernedFrontmatterTools } = await import(
      "../dist/mcp-server/tools/governedFrontmatterTools/registration.js"
    );
    const { Client } = await import("@modelcontextprotocol/client");
    const { McpServer, InMemoryTransport } = await import(
      "@modelcontextprotocol/server"
    );
    {
      const f = fixture();
      let refreshes = 0;
      f.backend.withContext = (_context, fn) => fn();
      const runtime = new GovernedNoteReplaceRuntime(
        f.backend,
        f.journal,
        f.adapter,
        5000,
        {
          async updateCacheForFile() {
            refreshes++;
          },
        },
      );
      try {
        const p = await runtime.plan({
          path: f.backend.path,
          nextContent: f.backend.content.replace("avant", "après"),
          idempotencyKey: "cache-lost",
        });
        f.backend.loseResponseAfterWriteOnce = true;
        assert.equal(
          (await runtime.apply(p.planRef, "cache-lost", "deferred")).outcome,
          "outcome_unknown",
        );
        assert.equal(refreshes, 1);
        for (let i = 0; i < 3; i++) {
          await runtime.status(p.planRef);
          await runtime.recover(p.planRef, "cache-lost", "deferred");
        }
        assert.equal(
          refreshes,
          1,
          "uncertain polling must not trigger cache/backend rereads during settlement",
        );
        f.advance(37250);
        assert.equal((await runtime.status(p.planRef)).outcome, "committed");
        assert.equal(refreshes, 2);
      } finally {
        runtime.close();
      }
    }
    for (const domain of ["text", "frontmatter"]) {
      const f = fixture();
      let refreshes = 0;
      f.backend.withContext = (_context, fn) => fn();
      const runtime = new GovernedNoteReplaceRuntime(
        f.backend,
        f.journal,
        f.adapter,
        5000,
        {
          async updateCacheForFile(target) {
            assert.equal(target, f.backend.path);
            refreshes++;
          },
        },
      );
      const server = new McpServer({ name: "fixture", version: "1" }),
        client = new Client({ name: "fixture", version: "1" });
      const [st, ct] = InMemoryTransport.createLinkedPair();
      await registerGovernedTextPatchTools(server, runtime);
      await registerGovernedFrontmatterTools(server, runtime);
      await server.connect(st);
      await client.connect(ct);
      const prefix = `obsidian_${domain}_patch`;
      async function call(suffix, args) {
        const raw = await client.callTool({
          name: `${prefix}_${suffix}`,
          arguments: args,
        });
        assert.ok(!raw.isError, JSON.stringify(raw));
        return JSON.parse(raw.content[0].text);
      }
      try {
        const operations =
          domain === "text"
            ? [{ op: "replace_literal", search: "avant", replacement: "après" }]
            : [{ op: "set", key: "statut", value: "test" }];
        const p = await call("plan", {
          path: f.backend.path,
          operations,
          idempotencyKey: "public-secret",
        });
        const args = { planRef: p.planRef, idempotencyKey: "public-secret" };
        const r = await call("apply", args);
        assert.equal(r.phase, "applying");
        assert.ok(r.postflight.checkAfter);
        assert.equal(
          refreshes,
          1,
          "the cache must observe the pending CAS, not wait 37 seconds",
        );
        assert.equal(
          (await call("status", { planRef: p.planRef })).phase,
          "applying",
        );
        assert.equal(refreshes, 1);
        const invalid = await client.callTool({
          name: `${prefix}_apply`,
          arguments: { ...args, completionMode: "unsafe" },
        });
        assert.ok(invalid.isError);
        f.advance(37250);
        const done = await call("status", { planRef: p.planRef });
        assert.equal(done.outcome, "committed");
        assert.equal(refreshes, 2);
        assert.ok(!JSON.stringify(done).includes("public-secret"));
        assert.ok(!JSON.stringify(done).includes("avant é"));
        assert.equal(f.backend.replaceCalls, 1);
      } finally {
        runtime.close();
        await client.close();
        await server.close();
      }
    }
  }
  {
    // a deferred apply can later be joined in blocking mode without another CAS
    const f = fixture(),
      p = await f.plan();
    await f.adapter.apply(p.planRef, "test", "deferred");
    f.adapter.options.sleep = async (ms) => {
      f.advance(ms);
    };
    assert.equal(
      (await f.adapter.apply(p.planRef, "test", "verified")).outcome,
      "committed",
    );
    assert.equal(f.backend.replaceCalls, 1);
  }
  {
    // optional blocking compatibility mode still waits and verifies
    const f = fixture(),
      p = await f.plan();
    f.adapter.options.sleep = async (ms) => {
      assert.equal(ms, 37250);
      f.advance(ms);
    };
    assert.equal(
      (await f.adapter.apply(p.planRef, "test", "verified")).outcome,
      "committed",
    );
  }
  console.log(
    "PASS deferred settlement: restart, polling, boundary, dates, drift, conflict, lost responses, recovery, blocking mode",
  );
} finally {
  for (const j of journals) j.close();
  rmSync(root, { recursive: true, force: true });
}
