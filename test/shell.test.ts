import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
import {createServer} from 'node:http';
import type {AddressInfo} from 'node:net';
import {streamChat} from '../server/ollama.ts';

test('offline navigation and assets come from the installed shell, private API traffic stays outside it', async () => {
  const routes = new Map();
  let network = 0;
  runInNewContext(readFileSync(new URL('../web/sw.js', import.meta.url),'utf8'),{
    URL, self:{location:{origin:'https://brain.test'},addEventListener:(kind:string,fn:Function)=>routes.set(kind,fn)},
    caches:{open:async()=>({match:async(key:string)=>'cached '+key})},fetch:()=>{network++; throw Error('offline')},
  });
  async function get(path:string, mode='cors') {
    let reply;
    routes.get('fetch')({request:{url:'https://brain.test'+path,method:'GET',mode},respondWith:(v:unknown)=>{reply=v}});
    return await reply;
  }
  assert.equal(await get('/','navigate'),'cached /index.html');
  assert.equal(await get('/styles.css'),'cached /styles.css');
  assert.equal(await get('/api/mac'),undefined);
  assert.equal(await get('/unknown.js'),undefined);
  assert.equal(network,0);
});
test('a remote Ollama alias receives no conversation or tools', async () => {
  const paths:string[]=[];
  const ollama=createServer((req,res)=>{
    paths.push(req.url!);
    res.end(JSON.stringify({remote_host:'https://example.invalid',capabilities:['tools']}));
  });
  await new Promise<void>(resolve=>ollama.listen(0,'127.0.0.1',resolve));
  try {
    const base='http://127.0.0.1:'+(ollama.address() as AddressInfo).port;
    await assert.rejects(streamChat(base,'example-alias',[{role:'user',content:'fixture'}]).next(), /Remote model/);
    assert.deepEqual(paths,['/api/show']);
  } finally { ollama.close(); }
});
