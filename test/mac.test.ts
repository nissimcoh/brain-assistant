import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import type { AddressInfo } from 'node:net';
import { createApp } from '../server/app.ts';
import { openDb } from '../server/db.ts';
import { loadConfig } from '../server/config.ts';
import { type Exec } from '../server/tools.ts';

// Simulate AppKit's GUI session. A quit here increments a counter only.
let quitCount = 0;
const fakeApp = (name: string, bundleIdentifier: string, processIdentifier: number) => ({
  localizedName: name, bundleIdentifier, processIdentifier, activationPolicy: 0, terminated: false,
  launchDate: { isNil: () => false, timeIntervalSince1970: 1234.5 },
  get terminate() { quitCount++; return true; },
});
const regularApps = [fakeApp('Notes','com.apple.Notes',41), fakeApp('Finder','com.apple.finder',44)];
const exec: Exec = async (path, args) => {
  if (path === '/usr/sbin/scutil') return {stdout:'Test Mac', stderr:''};
  if (path === 'pmset') return {stdout:"'AC Power' 90%; charging;", stderr:''};
  assert.equal(path, '/usr/bin/osascript');
  const stdout = runInNewContext(args[3] + '\nrun(argv)', {
    ObjC: { import() {}, unwrap:(x: unknown) => x },
    $: { NSWorkspace: { sharedWorkspace: { runningApplications: {count:regularApps.length, objectAtIndex:(i:number)=>regularApps[i]} } } },
    argv: args.slice(5),
  });
  return {stdout, stderr:''};
};
const dataDir = mkdtempSync(join(tmpdir(),'brain-machine-test-'));
const db = openDb(':memory:');
const app = createApp(loadConfig({dataDir}), db, {exec,platform:'darwin',autoWarm:false});
let base = '';
let headers: Record<string,string>;
before(async () => {
  await new Promise<void>(resolve => app.server.listen(0,'127.0.0.1',resolve));
  base = 'http://127.0.0.1:'+(app.server.address() as AddressInfo).port;
  const pair = app.auth.pair(app.auth.newPairingCode().code, 'Test phone')!;
  headers = {authorization:'Bearer '+pair.token,'content-type':'application/json'};
});
after(() => { app.server.close(); db.close(); });
test('only paired devices can read My Mac or request an app quit', async () => {
  assert.equal((await fetch(base+'/api/mac')).status,401);
  assert.equal((await fetch(base+'/api/mac/apps/quit',{method:'POST'})).status,401);
  const d = await (await fetch(base+'/api/mac',{headers})).json();
  assert.equal(d.name,'Test Mac'); assert.equal(d.battery.percent,90); assert.ok(d.ram.total>0);
  assert.equal(d.apps.find((a:{name:string})=>a.name==='Finder').canQuit,false);
});
test('quit requires confirmation, an eligible app and the same launch instance', async () => {
  const payload = {bundle:'com.apple.Notes',pid:41,started:'1234.5',confirmed:true};
  async function quit(edit: object) {
    return (await fetch(base+'/api/mac/apps/quit',{method:'POST',headers,body:JSON.stringify({...payload,...edit})})).status;
  }
  assert.equal(await quit({confirmed:false}),400);
  assert.equal(await quit({started:'1210'}),409);
  assert.equal(await quit({pid:44,bundle:'com.apple.finder'}),409);
  assert.equal(quitCount,0);
  assert.equal(await quit({}),202); assert.equal(quitCount,1);
});
test('manual memory edits and additions use the same private-data rules as chat', async () => {
  const m=db.addMemory('בדיקת עריכה','manual');
  const body=JSON.stringify({text:'סיסמה לדוגמה בלבד'});
  for (const [url,method] of [['/api/memories','POST'],['/api/memories/'+m.id,'PUT']]) {
    assert.equal((await fetch(base+url,{method,headers,body})).status,400);
  }
  assert.equal(db.getMemory(m.id)?.text,'בדיקת עריכה');
});
