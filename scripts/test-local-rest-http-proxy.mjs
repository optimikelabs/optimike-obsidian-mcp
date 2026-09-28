import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {spawn} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

test('HTTP fixture bypasses hostile ambient proxies', {timeout:30000}, async()=>{
  let forwarded=0;
  const proxy=createServer((_req,res)=>{forwarded++;res.writeHead(502).end('fixture proxy must not be used');});
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const url='http://127.0.0.1:'+proxy.address().port;
  const env={...process.env,HTTP_PROXY:url,http_proxy:url,HTTPS_PROXY:url,https_proxy:url,
    ALL_PROXY:url,all_proxy:url,NO_PROXY:'',no_proxy:''};
  const child=spawn(process.execPath,['--test',fileURLToPath(new URL('./test-local-rest-http-contract.mjs',import.meta.url))],
    {env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  let output='';child.stdout.on('data',b=>{if(output.length<32768)output+=b;});
  child.stderr.on('data',b=>{if(output.length<32768)output+=b;});
  const timer=setTimeout(()=>child.kill(),20000);
  try {
    const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    assert.equal(forwarded,0,'a loopback fixture request reached ambient proxy');
    assert.equal(code,0,output);
  } finally {clearTimeout(timer);proxy.closeAllConnections();await new Promise(resolve=>proxy.close(resolve));}
});
