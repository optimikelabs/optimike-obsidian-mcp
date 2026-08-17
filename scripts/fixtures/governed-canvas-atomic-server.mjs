import { createHash } from "node:crypto";
import http from "node:http";

export const CANVAS_FIXTURE_PATH = "Canary/Flow-P3.canvas";
export const CANVAS_INITIAL_CONTENT = `${JSON.stringify(
  {
    nodes: [
      {
        id: "a",
        type: "text",
        x: 0,
        y: 0,
        width: 240,
        height: 120,
        text: "Before",
        unknownNodeField: { keep: true },
      },
    ],
    edges: [],
    unknownRootField: "keep",
  },
  null,
  2,
)}\n`;

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

export class GovernedCanvasAtomicServer {
  constructor() {
    this.bindingFingerprint = sha256("governed-canvas-mcp-fixture");
    this.content = CANVAS_INITIAL_CONTENT;
    this.writes = 0;
    this.canvasWritesEnabled = true;
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
    if (!address || typeof address !== "object") {
      throw new Error("Fixture server has no address.");
    }
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
      url.pathname === "/extensions/obsidian-atomic-write-bridge/status"
    ) {
      json(res, 200, {
        ok: true,
        contractVersion: 1,
        plugin: { id: "obsidian-atomic-write-bridge", version: "0.4.0" },
        backend: {
          kind: "obsidian-vault-process",
          bindingFingerprint: this.bindingFingerprint,
          atomicCas: true,
          writeEnabled: false,
          canvasAtomicCas: true,
          canvasWriteEnabled: this.canvasWritesEnabled,
        },
        limits: { markdownOnly: true },
      });
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname === "/extensions/obsidian-atomic-write-bridge/canvas/read"
    ) {
      const request = await body(req);
      if (request.path !== CANVAS_FIXTURE_PATH) {
        json(res, 404, { error: { code: "canvas_not_found" } });
        return;
      }
      json(res, 200, {
        ok: true,
        contractVersion: 1,
        path: CANVAS_FIXTURE_PATH,
        content: this.content,
        sha256: sha256(this.content),
        size: Buffer.byteLength(this.content),
        bindingFingerprint: this.bindingFingerprint,
      });
      return;
    }
    if (
      req.method === "POST" &&
      url.pathname === "/extensions/obsidian-atomic-write-bridge/canvas/cas"
    ) {
      const request = await body(req);
      const actual = sha256(this.content);
      if (!this.canvasWritesEnabled) {
        json(res, 403, {
          ok: false,
          contractVersion: 1,
          error: { code: "canvas_writes_disabled", message: "disabled" },
        });
        return;
      }
      if (
        request.bindingFingerprint !== this.bindingFingerprint ||
        request.expectedSha256 !== actual
      ) {
        json(res, 409, {
          ok: false,
          contractVersion: 1,
          error: {
            code: "hash_conflict",
            message: "Canvas changed",
            details: { actualSha256: actual },
          },
        });
        return;
      }
      this.content = request.nextContent;
      this.writes += 1;
      json(res, 200, {
        ok: true,
        contractVersion: 1,
        path: CANVAS_FIXTURE_PATH,
        beforeSha256: actual,
        afterSha256: sha256(this.content),
        size: Buffer.byteLength(this.content),
        bindingFingerprint: this.bindingFingerprint,
      });
      return;
    }
    json(res, 404, { error: "fixture route not found" });
  }
}
