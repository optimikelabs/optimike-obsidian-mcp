import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import ts from 'typescript';
const source = readFileSync(new URL('../plugins/shared/restOpenApi.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
const { describeRestRoutes } = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
function host(version=3) {
  const registrations = [], contributions = [];
  const native = {
    apiVersion: version,
    addRoute(path) {
      assert.equal(this, native);
      const route = {};
      for (const method of ['get','post','put','patch','delete','head','options']) route[method] = function(...handlers) {
        assert.equal(this, route); registrations.push({path, method, handlers}); return route;
      };
      return route;
    },
    addOpenApiDescription(d) { assert.equal(this, native); contributions.push(d); },
    unregister() { assert.equal(this,native); registrations.length=0; contributions.length=0; },
  };
  return { native, registrations, contributions };
}
test('registration preserves host receivers handlers chaining and method coverage', () => {
  const h=host(), d=describeRestRoutes(h.native,'fixture-bridge');
  const handler=()=>{throw new Error('must never execute');};
  d.api.addRoute('/extensions/fixture/notes/:id').get(handler).post(handler);
  assert.equal(d.publish(),'published'); assert.equal(d.publish(),'published');
  assert.equal(h.contributions.length,1);
  assert.equal(h.registrations.length,2); assert.equal(h.registrations[0].handlers[0],handler);
  const p=h.contributions[0].paths['/extensions/fixture/notes/{id}'];
  assert.ok(p.get); assert.ok(p.post); assert.equal(p.get.parameters[0].name,'id');
  assert.equal(p.get['x-optimike-schema-coverage'],'route-and-method-only');
  assert.equal('requestBody' in p.post,false);
});
test('API v2 and absent optional method keep routes functional', () => {
  for(const version of [undefined,1,2,3]) {
    const h=host(version); if(version===undefined)delete h.native.apiVersion;
    if(version===3)delete h.native.addOpenApiDescription;
    const d=describeRestRoutes(h.native,'old-host'); d.api.addRoute('/test').get(()=>{});
    assert.equal(d.publish(),'unsupported'); assert.equal(h.registrations.length,1);
  }
});
test('a documentation collision or host exception does not unregister working routes', () => {
  const h=host(); h.native.addOpenApiDescription=()=>{throw new Error('private sentinel');};
  const d=describeRestRoutes(h.native,'collision'); d.api.addRoute('/test').get(()=>{});
  assert.equal(d.publish(),'failed'); assert.equal(h.registrations.length,1);
  assert.equal(JSON.stringify(d.state()).includes('sentinel'),false);
});
test('unregister cleans routes and documentation through the same host handle', () => {
  const h=host(), d=describeRestRoutes(h.native,'fixture'); d.api.addRoute('/test').get(()=>{}); d.publish();
  d.api.unregister(); assert.equal(h.registrations.length,0); assert.equal(h.contributions.length,0);
  const next=describeRestRoutes(h.native,'fixture'); next.api.addRoute('/new').get(()=>{}); next.publish();
  assert.deepEqual(Object.keys(h.contributions[0].paths),['/new']);
});
test('greedy Bases parameters are represented without pretending their input schema is complete', () => {
  const h=host(), d=describeRestRoutes(h.native,'bases');
  d.api.addRoute('/bases/:id(*)/config').get(()=>{}).put(()=>{}); d.publish();
  const p=h.contributions[0].paths['/bases/{id}/config']; assert.ok(p.get); assert.ok(p.put);
  assert.equal(p['x-optimike-express-pattern'],'/bases/:id(*)/config');
});
test('unsupported or ambiguous patterns fail optional publication, not real registration', () => {
  for(const pattern of ['/prefix/*','/:id/:id','/:id(abc)']) {
    const h=host(),d=describeRestRoutes(h.native,'fixture'); d.api.addRoute(pattern).get(()=>{});
    assert.equal(d.publish(),'failed'); assert.equal(h.registrations.length,1);
  }
  const h=host(),d=describeRestRoutes(h.native,'fixture');
  d.api.addRoute('/:id(*)').get(()=>{}); d.api.addRoute('/:id').post(()=>{});
  assert.equal(d.publish(),'failed'); assert.equal(h.registrations.length,2);
});
test('a route registration error remains an error rather than being hidden as documentation failure', () => {
  const h=host(); const expected=new Error('route failure'); h.native.addRoute=()=>{throw expected;};
  const d=describeRestRoutes(h.native,'fixture'); assert.throws(()=>d.api.addRoute('/x'),e=>e===expected);
});


for (const id of ['obsidian-atomic-write-bridge','obsidian-bases-bridge','obsidian-operon-bridge']) {
  test('actual ' + id + ' mount preserves routes on old host, publication and collision', async () => {
    const { createRequire } = await import('node:module');
    const { runInNewContext } = await import('node:vm');
    const { fileURLToPath } = await import('node:url');
    const localRequire = createRequire(new URL('../plugins/' + id + '/package.json', import.meta.url));
    const { buildSync } = localRequire('esbuild');
    const entry = fileURLToPath(new URL('../plugins/' + id + '/src/main.ts', import.meta.url));
    const code = buildSync({entryPoints:[entry],bundle:true,write:false,platform:'node',format:'cjs',external:['obsidian','electron'],logLevel:'silent'}).outputFiles[0].text;
    const stableRegistrations=[];
    for(const mode of ['old','current','collision']) {
      const h=host(mode==='old'?2:3), messages=[];
      if(mode==='collision') h.native.addOpenApiDescription=()=>{throw new Error('private collision detail');};
      class Plugin { constructor(){ this.manifest={id,name:id,version:'0.0.0-test'}; } register(){} }
      class TFile {} class TFolder {}
      const obsidian=new Proxy({Plugin,TFile,TFolder,Platform:{isDesktopApp:false}}, {get:(target,key)=>target[key]??class {}});
      const module={exports:{}};
      runInNewContext(code,{module,exports:module.exports,require:(name)=>name==='obsidian'?obsidian:localRequire(name),console:{log:()=>{},warn:(s)=>messages.push(s),info:(s)=>messages.push(s),error:(s)=>messages.push(s)},Buffer,process,setTimeout,clearTimeout,setInterval,clearInterval,URL});
      const plugin=new module.exports.default();
      const provider={getPublicApi:()=>h.native};
      plugin.app={workspace:{onLayoutReady:cb=>cb()},plugins:{plugins:{'obsidian-local-rest-api':provider},getPlugin:()=>provider}};
      plugin.settings={};
      let cleanup;
      try {
        if(id==='obsidian-operon-bridge') cleanup=plugin.mountRestExtension(provider);
        else { await plugin.registerRestExtension(); cleanup=()=>plugin.restLifecycle.stop(); }
        assert.ok(h.registrations.length>=6, 'actual mounting registered routes');
        const expected=h.registrations.map(r=>r.method+' '+r.path).sort();
        stableRegistrations.push(JSON.stringify(expected));
        if(mode==='current') {
          assert.equal(h.contributions.length,1);
          const actual=[];
          for(const p of Object.values(h.contributions[0].paths))
            for(const method of ['get','post','put','patch','delete','head','options'])
              if(p[method])actual.push(method+' '+p['x-optimike-express-pattern']);
          assert.equal(JSON.stringify([...new Set(expected)].sort()),JSON.stringify(actual.sort()));
        } else { assert.equal(h.contributions.length,0); }
        assert.equal(messages.join(' ').includes('private collision detail'),false);
      } finally { cleanup?.(); plugin.restLifecycle?.stop(); }
      assert.equal(h.registrations.length,0); assert.equal(h.contributions.length,0);
    }
    assert.equal(new Set(stableRegistrations).size,1, 'optional docs cannot change route coverage');
  });
}


test('CI watches transitive bridge sources and build inputs in both event filters', async () => {
 const {default:yaml}=await import('js-yaml');
 const w=yaml.load(readFileSync(new URL('../.github/workflows/bridge-openapi.yml',import.meta.url),'utf8'));
 for(const event of ['pull_request','push'])for(const input of ['src/**','plugins/**','package*.json','tsconfig*.json','scripts/make-executable.mjs'])
   assert.ok(w.on[event].paths.includes(input),event+' misses '+input);
});
