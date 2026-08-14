import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";

export const FRONTMATTER_FIXTURE_PATH = "Fixture/Governed Frontmatter.md";
export const FRONTMATTER_INITIAL_CONTENT = [
  "---",
  "# keep header",
  "création: 2026-08-14",
  "statut: actif # replace this entry only",
  "meta:",
  "  nested: true",
  "# keep separator",
  'owner: "Mike"',
  "",
  "---",
  "Body must stay byte-identical.",
  "",
].join("\n");

export function fixtureSha256(content) {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function json(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

async function requestBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export class GovernedFrontmatterAtomicServer {
  constructor(content = FRONTMATTER_INITIAL_CONTENT) {
    this.server = http.createServer((request, response) => {
      void this.handle(request, response).catch((error) => {
        if (!response.headersSent) {
          json(response, 500, {
            ok: false,
            error: {
              code: "fixture_error",
              message: error instanceof Error ? error.message : String(error),
            },
          });
        } else {
          response.destroy(error instanceof Error ? error : undefined);
        }
      });
    });
    this.reset(content);
  }

  reset(content = FRONTMATTER_INITIAL_CONTENT) {
    this.content = content;
    this.bindingFingerprint = fixtureSha256("governed-frontmatter-fixture");
    this.writeEnabled = true;
    this.readRequests = 0;
    this.casRequests = 0;
    this.successfulWrites = 0;
    this.failBeforeWriteNext = false;
    this.loseResponseAfterWriteNext = false;
    this.mutateAfterReadNumber = undefined;
    this.mutateAfterReadContent = undefined;
    this.blockedCas = undefined;
  }

  async listen() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", () => {
        this.server.off("error", reject);
        resolve();
      });
    });
    const address = this.server.address();
    assert.ok(address && typeof address === "object");
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async close() {
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(resolve));
  }

  mutateAfterRead(number, nextContent) {
    this.mutateAfterReadNumber = number;
    this.mutateAfterReadContent = nextContent;
  }

  blockNextCas() {
    let enteredResolve;
    let releaseResolve;
    const entered = new Promise((resolve) => {
      enteredResolve = resolve;
    });
    const released = new Promise((resolve) => {
      releaseResolve = resolve;
    });
    this.blockedCas = {
      entered: () => enteredResolve(),
      released,
      release: () => releaseResolve(),
    };
    return { entered, release: this.blockedCas.release };
  }

  async handle(request, response) {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/") {
      json(response, 200, {
        service: "Obsidian Local REST API",
        authenticated: true,
        versions: { obsidian: "fixture", self: "5.0.2" },
      });
      return;
    }
    if (
      request.method === "GET" &&
      url.pathname === "/extensions/obsidian-atomic-write-bridge/status"
    ) {
      json(response, 200, {
        ok: true,
        contractVersion: 1,
        plugin: { id: "obsidian-atomic-write-bridge", version: "0.1.0" },
        backend: {
          kind: "obsidian-vault-process",
          bindingFingerprint: this.bindingFingerprint,
          atomicCas: true,
          writeEnabled: this.writeEnabled,
        },
        limits: { markdownOnly: true },
      });
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/extensions/obsidian-atomic-write-bridge/notes/read"
    ) {
      const payload = await requestBody(request);
      if (payload.path !== FRONTMATTER_FIXTURE_PATH) {
        json(response, 404, {
          ok: false,
          contractVersion: 1,
          error: { code: "note_not_found", message: "Fixture note not found." },
        });
        return;
      }
      this.readRequests += 1;
      const content = this.content;
      json(response, 200, {
        ok: true,
        contractVersion: 1,
        path: FRONTMATTER_FIXTURE_PATH,
        content,
        sha256: fixtureSha256(content),
        size: Buffer.byteLength(content, "utf8"),
        bindingFingerprint: this.bindingFingerprint,
      });
      if (this.mutateAfterReadNumber === this.readRequests) {
        this.content = this.mutateAfterReadContent;
        this.mutateAfterReadNumber = undefined;
        this.mutateAfterReadContent = undefined;
      }
      return;
    }
    if (
      request.method === "POST" &&
      url.pathname === "/extensions/obsidian-atomic-write-bridge/notes/cas"
    ) {
      this.casRequests += 1;
      const payload = await requestBody(request);
      if (!this.writeEnabled) {
        json(response, 403, {
          ok: false,
          contractVersion: 1,
          error: {
            code: "writes_disabled",
            message: "Atomic writes are disabled.",
          },
        });
        return;
      }
      if (
        payload.path !== FRONTMATTER_FIXTURE_PATH ||
        payload.bindingFingerprint !== this.bindingFingerprint
      ) {
        json(response, 409, {
          ok: false,
          contractVersion: 1,
          error: { code: "binding_conflict", message: "Binding conflict." },
        });
        return;
      }
      if (this.failBeforeWriteNext) {
        this.failBeforeWriteNext = false;
        request.socket.destroy();
        return;
      }
      if (this.blockedCas) {
        const gate = this.blockedCas;
        this.blockedCas = undefined;
        gate.entered();
        await gate.released;
      }
      const beforeSha256 = fixtureSha256(this.content);
      if (payload.expectedSha256 !== beforeSha256) {
        json(response, 409, {
          ok: false,
          contractVersion: 1,
          error: {
            code: "hash_conflict",
            message: "The note changed after planning.",
            details: { actualSha256: beforeSha256 },
          },
        });
        return;
      }
      this.content = payload.nextContent;
      this.successfulWrites += 1;
      if (this.loseResponseAfterWriteNext) {
        this.loseResponseAfterWriteNext = false;
        request.socket.destroy();
        return;
      }
      json(response, 200, {
        ok: true,
        contractVersion: 1,
        path: FRONTMATTER_FIXTURE_PATH,
        beforeSha256,
        afterSha256: fixtureSha256(this.content),
        size: Buffer.byteLength(this.content, "utf8"),
        bindingFingerprint: this.bindingFingerprint,
      });
      return;
    }
    json(response, 404, { error: "not_found", path: url.pathname });
  }

  content = FRONTMATTER_INITIAL_CONTENT;
  bindingFingerprint = "";
  writeEnabled = true;
  readRequests = 0;
  casRequests = 0;
  successfulWrites = 0;
  failBeforeWriteNext = false;
  loseResponseAfterWriteNext = false;
  mutateAfterReadNumber = undefined;
  mutateAfterReadContent = undefined;
  blockedCas = undefined;
  baseUrl = "";
}
