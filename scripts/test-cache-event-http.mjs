import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as pause } from "node:timers/promises";
import { test } from "node:test";
import axios from "axios";
import {
  consumeVaultEventStream,
  projectVaultEvent,
} from "../dist/services/obsidianRestAPI/eventStreams.js";

async function fixture(run, options = {}) {
  const requests = [];
  let response;
  let ready = false;
  const notices = [];
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      body: Buffer.concat(chunks).toString(),
    });
    if (req.method === "POST") {
      if (options.status) {
        res.writeHead(options.status).end("PRIVATE_ERROR");
        return;
      }
      const origin = "http://127.0.0.1:" + server.address().port;
      res.writeHead(201, { "content-type": "application/json" }).end(
        JSON.stringify({
          id: "subscription123",
          emitter: "vault",
          event: "modify",
          signed: true,
          url:
            (options.foreign ? "http://example.invalid" : origin) +
            "/events/vault/modify/subscription123/?sig=PRIVATE_SIGNED_VALUE",
          expiresAt: new Date(Date.now() + 300000).toISOString(),
        }),
      );
      return;
    }
    response = res;
    res.writeHead(200, {
      "content-type": options.badMime ? "text/plain" : "text/event-stream",
    });
    res.write(": connected\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = "http://127.0.0.1:" + server.address().port;
  const client = axios.create({
    baseURL: base,
    proxy: false,
    headers: { Authorization: "Bearer FIXTURE_KEY" },
  });
  const controller = new AbortController();
  const result = consumeVaultEventStream(
    client,
    base,
    "modify",
    controller.signal,
    () => {
      ready = true;
    },
    (e) => notices.push(e),
    { handshakeMs: 2000, idleMs: options.idleMs ?? 2000 },
  ).catch((error) => error);
  const wait = async (condition) => {
    const until = Date.now() + 3000;
    while (!condition()) {
      if (Date.now() > until) throw new Error("fixture timeout");
      await pause(5);
    }
  };
  try {
    await run({
      requests,
      notices,
      result,
      wait,
      controller,
      ready: () => ready,
      write: (data) => response.write(data),
      end: () => response.end(),
    });
  } finally {
    controller.abort();
    await result;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
const payload = {
  emitter: "vault",
  event: "modify",
  path: "Note.md",
  isFolder: false,
  file: {
    content: "PRIVATE_CONTENT",
    frontmatter: { secret: "PRIVATE_METADATA" },
    links: ["PRIVATE_LINK"],
  },
};
const message = (id, data = payload) =>
  "id: " + id + "\nevent: modify\ndata: " + JSON.stringify(data) + "\n\n";

test("projection discards all note metadata and the global numeric counter", () => {
  assert.deepEqual(
    projectVaultEvent("modify", JSON.stringify(payload), "deadbeef-999"),
    { event: "modify", path: "Note.md", isFolder: false, epoch: "deadbeef" },
  );
});
for (const path of [
  "../outside.md",
  "/absolute.md",
  "Dir/../outside.md",
  "C:/outside.md",
  "Dir\\outside.md",
])
  test("untrusted event path refused: " + path, () =>
    assert.throws(() =>
      projectVaultEvent("modify", JSON.stringify({ ...payload, path })),
    ),
  );
test("authenticated REST streaming strips signed query parameters; gaps are ordinary events", async () =>
  fixture(async (f) => {
    await f.wait(f.ready);
    f.write(message("deadbeef-1"));
    f.write(message("deadbeef-9"));
    await f.wait(() => f.notices.length === 2);
    assert.equal(f.requests.length, 2);
    assert.ok(f.requests.every((r) => r.auth === "Bearer FIXTURE_KEY"));
    assert.equal(f.requests[0].body, "{}");
    assert.equal(f.requests[1].url, "/events/vault/modify/subscription123/");
    assert.equal(JSON.stringify(f.notices).includes("PRIVATE"), false);
    f.end();
    assert.equal((await f.result).reason, "unavailable");
  }));
test("split UTF-8 and CRLF chunks yield one event", async () =>
  fixture(async (f) => {
    await f.wait(f.ready);
    const bytes = Buffer.from(
      message("deadbeef-2", { ...payload, path: "\u00c9.md" }).replaceAll(
        "\n",
        "\r\n",
      ),
    );
    const at = bytes.indexOf(Buffer.from("\u00c9"));
    f.write(bytes.subarray(0, at + 1));
    f.write(bytes.subarray(at + 1));
    await f.wait(() => f.notices.length === 1);
    assert.equal(f.notices[0].path, "\u00c9.md");
  }));
test("foreign grant cannot forward the API credential", async () =>
  fixture(
    async (f) => {
      const error = await f.result;
      assert.equal(error.reason, "invalid_stream");
      assert.equal(f.requests.length, 1);
      assert.equal(JSON.stringify(error).includes("PRIVATE_SIGNED"), false);
    },
    { foreign: true },
  ));
for (const [status, reason] of [
  [401, "forbidden"],
  [403, "forbidden"],
  [404, "unsupported"],
  [503, "unavailable"],
])
  test("subscription status " + status + " is a finite diagnostic", async () =>
    fixture(
      async (f) => {
        const error = await f.result;
        assert.equal(error.reason, reason);
        assert.equal(error.message.includes("PRIVATE_ERROR"), false);
      },
      { status },
    ),
  );
test("wrong response media type is refused", async () =>
  fixture(
    async (f) => {
      assert.equal((await f.result).reason, "invalid_stream");
    },
    { badMime: true },
  ));
test("unfinished oversized event cannot grow unbounded", async () =>
  fixture(async (f) => {
    await f.wait(f.ready);
    f.write("data: " + "x".repeat(300000));
    assert.equal((await f.result).reason, "invalid_stream");
  }));
test("invalid JSON closes coverage with an explicit failure", async () =>
  fixture(async (f) => {
    await f.wait(f.ready);
    f.write("event: modify\ndata: NOT_JSON\n\n");
    assert.equal((await f.result).reason, "invalid_stream");
  }));
test("idle stream is closed and must be reconciled by its owner", async () =>
  fixture(
    async (f) => {
      await f.wait(f.ready);
      assert.equal((await f.result).reason, "unavailable");
    },
    { idleMs: 100 },
  ));
test("explicit shutdown closes the stream without leaking a reader", async () =>
  fixture(async (f) => {
    await f.wait(f.ready);
    f.controller.abort();
    assert.equal((await f.result).reason, "aborted");
  }));


// Stateful upstream fixture: subscriptions survive socket loss, not expiry/reload.
async function reconnectFixture(run, options = {}) {
  const grants = new Map(), requests = [], responses = new Set();
  let posts = 0, nextStatus = 0, hold = false;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    const event = url.pathname.split('/')[3];
    requests.push({method:req.method,url:req.url,auth:req.headers.authorization});
    if(req.method === 'POST') {
      for await(const _ of req) {}
      const id = 'reconnect-grant-' + ++posts;
      const expiresAt = options.badExpiry ?? new Date(Date.now()+(options.ttlMs ?? 300000)).toISOString();
      grants.set(id, {event,expiresAt});
      if(options.losePost) {req.socket.destroy();return;}
      res.writeHead(201,{'content-type':'application/json'}).end(JSON.stringify({
        id,event,emitter:'vault',signed:true,expiresAt,
        url:'http://127.0.0.1:'+server.address().port+'/events/vault/'+event+'/'+id+'/?sig=PRIVATE',
      }));
      return;
    }
    if(nextStatus) {const status=nextStatus;nextStatus=0;res.writeHead(status).end('{}');return;}
    const grant=grants.get(url.pathname.split('/')[4]);
    if(!grant || grant.event!==event || Date.parse(grant.expiresAt)<Date.now()) {res.writeHead(404).end('{}');return;}
    responses.add(res);res.on('close',()=>responses.delete(res));
    res.writeHead(200,{'content-type':'text/event-stream'});res.write(': connected\n\n');
    if(!hold) setImmediate(()=>res.end());
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const client=axios.create({baseURL:base,proxy:false,headers:{Authorization:'Bearer FIXTURE_KEY'}});
  const cycle=(event='modify',args={})=>consumeVaultEventStream(args.client??client,base,event,
    args.signal??new AbortController().signal,args.ready??(()=>{}),()=>{},
    {handshakeMs:1000,idleMs:1000}).catch(error=>error);
  try {await run({cycle,requests,client,base,posts:()=>posts,invalidate:()=>grants.clear(),
    fail:status=>{nextStatus=status;},hold:value=>{hold=value;}});}
  finally {for(const res of responses)res.destroy();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}

test('repeated four-stream reconnects reuse four grants instead of exhausting 256 subscriptions',()=>reconnectFixture(async f=>{
  for(let round=0;round<70;round++) for(const event of ['create','modify','delete','rename']) {
    assert.equal((await f.cycle(event)).reason,'unavailable');
  }
  assert.equal(f.posts(),4);
  assert.equal(f.requests.filter(r=>r.method==='GET').length,280);
  assert.ok(f.requests.filter(r=>r.method==='GET').every(r=>!r.url.includes('?')));
}));
test('expired grants are replaced once before reopening',()=>reconnectFixture(async f=>{
  await f.cycle();await pause(1150);await f.cycle();await f.cycle();assert.equal(f.posts(),2);
},{ttlMs:1000}));
test('host reload invalidates a missing GET grant without declaring events unsupported',()=>reconnectFixture(async f=>{
  await f.cycle();f.invalidate();assert.equal((await f.cycle()).reason,'unavailable');
  await f.cycle();await f.cycle();assert.equal(f.posts(),2);
}));
for(const [status,reason] of [[503,'unavailable'],[403,'forbidden']]) test('GET '+status+' preserves the reusable subscription',()=>reconnectFixture(async f=>{
  await f.cycle();f.fail(status);assert.equal((await f.cycle()).reason,reason);await f.cycle();assert.equal(f.posts(),1);
}));
test('simultaneous same-client event calls neither allocate nor release another stream slot',()=>reconnectFixture(async f=>{
  f.hold(true);let connected;const ready=new Promise(resolve=>{connected=resolve;});
  const control=new AbortController();const first=f.cycle('modify',{signal:control.signal,ready:connected});
  try {await ready;assert.equal((await f.cycle()).reason,'unavailable');assert.equal(f.posts(),1);}
  finally {control.abort();await first;}
  f.hold(false);await f.cycle();assert.equal(f.posts(),1);
}));
test('grants are scoped to the owning authenticated HTTP client',()=>reconnectFixture(async f=>{
  const other=axios.create({baseURL:f.base,proxy:false,headers:{Authorization:'Bearer OTHER_KEY'}});
  await f.cycle();await f.cycle('modify',{client:other});await f.cycle();assert.equal(f.posts(),2);
}));
for(const badExpiry of ['invalid',new Date(0).toISOString()]) test('invalid or expired grant lifetime is refused: '+badExpiry,()=>reconnectFixture(async f=>{
  assert.equal((await f.cycle()).reason,'invalid_stream');assert.equal(f.requests.filter(r=>r.method==='GET').length,0);
},{badExpiry}));
test('lost POST acknowledgements request bounded orphan lifetime instead of host maximum TTL',()=>reconnectFixture(async f=>{
  await f.cycle();assert.equal(f.posts(),1);
  assert.equal(new URL(f.requests[0].url,f.base).searchParams.get('ttl'),'30');
},{losePost:true}));
