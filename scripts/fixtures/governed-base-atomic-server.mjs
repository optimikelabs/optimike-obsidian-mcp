import { createHash } from "node:crypto";
import http from "node:http";

export const BASE_FIXTURE_PATH = "Canary/PROJETS-P2.base";
export const BASE_INITIAL_YAML =
  "formulas:\n  score: old\nviews:\n  - type: table\n    name: Préservée\n";

const sha256 = (value) =>
  createHash("sha256").update(value, "utf8").digest("hex");

function json(res, status, payload) {
  const response = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(response),
  });
  res.end(response);
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export class GovernedBaseAtomicServer {
  constructor() {
    this.bindingFingerprint = sha256("governed-base-mcp-fixture");
    this.yaml = BASE_INITIAL_YAML;
    this.writes = 0;
    this.legacyConfigWritesEnabled = false;
    this.server = http.createServer((req, res) => {
      void this.handle(req, res).catch((error) =>
        json(res, 500, { error: String(error) }),
      );
    });
  }

  async listen() {
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(0, "127.0.0.1", resolve);
    });
    const address = this.server.address();
    if (!address || typeof address !== "object")
      throw new Error("Fixture server has no address.");
    this.baseUrl = `http://127.0.0.1:${address.port}`;
  }

  async close() {
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(resolve));
  }

  async handle(req, res) {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/") {
      json(res, 200, {
        service: "Obsidian Local REST API",
        authenticated: true,
        versions: { obsidian: "fixture", self: "5.0.2" },
      });
      return;
    }
    if (
      req.method === "GET" &&
      url.pathname === "/extensions/obsidian-bases-bridge/atomic/status"
    ) {
      json(res, 200, {
        ok: true,
        contractVersion: 1,
        plugin: { id: "obsidian-bases-bridge", version: "1.1.0" },
        backend: {
          kind: "obsidian-vault-process-base",
          bindingFingerprint: this.bindingFingerprint,
          atomicCas: true,
          writeEnabled: true,
        },
        limits: { baseOnly: true, sourcePreservingCompilerRequired: true },
        migration: {
          legacyConfigWritesEnabled: this.legacyConfigWritesEnabled,
        },
      });
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname === "/extensions/obsidian-bases-bridge/atomic/bases/read"
    ) {
      const request = await body(req);
      if (request.path !== BASE_FIXTURE_PATH)
        return json(res, 404, { error: { code: "base_not_found" } });
      json(res, 200, {
        ok: true,
        contractVersion: 1,
        path: BASE_FIXTURE_PATH,
        yaml: this.yaml,
        sha256: sha256(this.yaml),
        size: Buffer.byteLength(this.yaml),
        bindingFingerprint: this.bindingFingerprint,
      });
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname === "/extensions/obsidian-bases-bridge/atomic/bases/cas"
    ) {
      const request = await body(req);
      const actual = sha256(this.yaml);
      if (
        request.bindingFingerprint !== this.bindingFingerprint ||
        request.expectedSha256 !== actual
      ) {
        json(res, 409, {
          ok: false,
          contractVersion: 1,
          error: {
            code: "hash_conflict",
            message: "Base changed",
            details: { actualSha256: actual },
          },
        });
        return;
      }
      this.yaml = request.nextYaml;
      this.writes += 1;
      json(res, 200, {
        ok: true,
        contractVersion: 1,
        path: BASE_FIXTURE_PATH,
        beforeSha256: actual,
        afterSha256: sha256(this.yaml),
        size: Buffer.byteLength(this.yaml),
        bindingFingerprint: this.bindingFingerprint,
      });
      return;
    }
    json(res, 404, { error: "fixture route not found" });
  }
}
