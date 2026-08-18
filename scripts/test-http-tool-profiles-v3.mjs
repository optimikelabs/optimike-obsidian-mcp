import assert from "node:assert/strict";
import http from "node:http";
import {
  clearHttpToolProfileSessionsForTest,
  installHttpToolProfileBoundary,
} from "../dist/mcp-server/toolSurface/httpBoundary.js";
import { currentToolSurfaceProfile } from "../dist/mcp-server/toolSurface/runtime.js";

clearHttpToolProfileSessionsForTest();
installHttpToolProfileBoundary();

const observations = [];
const server = http.createServer((request, response) => {
  observations.push({
    method: request.method,
    url: request.url,
    headerProfile: request.headers["x-optimike-tool-profile"],
    contextProfile: currentToolSurfaceProfile(),
  });
  if (request.method === "POST" && request.url === "/mcp") {
    response.setHeader("Mcp-Session-Id", "profile-session-1");
  }
  response.statusCode = 200;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify({ ok: true }));
});

await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const base = `http://127.0.0.1:${address.port}`;

try {
  const initialize = await fetch(`${base}/mcp/standard`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(initialize.status, 200);
  assert.equal(initialize.headers.get("mcp-session-id"), "profile-session-1");
  assert.deepEqual(observations.at(-1), {
    method: "POST",
    url: "/mcp",
    headerProfile: "standard",
    contextProfile: "standard",
  });

  const sameProfile = await fetch(`${base}/mcp/standard`, {
    headers: { "Mcp-Session-Id": "profile-session-1" },
  });
  assert.equal(sameProfile.status, 200);
  assert.equal(observations.at(-1).contextProfile, "standard");

  const observedBeforeMismatch = observations.length;
  const mismatch = await fetch(`${base}/mcp/full`, {
    headers: { "Mcp-Session-Id": "profile-session-1" },
  });
  assert.equal(mismatch.status, 404);
  assert.equal(observations.length, observedBeforeMismatch);
  assert.match(await mismatch.text(), /Invalid or expired session ID/u);

  const unknown = await fetch(`${base}/mcp/standrad`);
  assert.equal(unknown.status, 404);
  assert.equal(observations.length, observedBeforeMismatch);

  const legacy = await fetch(`${base}/mcp`, { method: "POST", body: "{}" });
  assert.equal(legacy.status, 200);
  assert.equal(observations.at(-1).contextProfile, "full");
  assert.equal(observations.at(-1).url, "/mcp");

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.equal(observations.at(-1).url, "/healthz");
} finally {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  clearHttpToolProfileSessionsForTest();
}

console.log("PASS: HTTP tool profiles are selected before routing and bound to sessions");
