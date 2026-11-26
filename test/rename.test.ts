// Version 0.15 renamed Felipe to Brain. What the old name kept on the Mac moves over, once, and
// nothing is lost: the data folder, the database, the Google connection in the Keychain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { migrateLegacyData } from '../server/config.ts';
import { keychainStore } from '../server/google.ts';

test('~/.felipe becomes ~/.brain, felipe.db becomes brain.db (with its journal), once', () => {
  const home = mkdtempSync(join(tmpdir(), 'brain-rename-'));
  mkdirSync(join(home, '.felipe/logs'), { recursive: true });
  for (const [f, v] of [['felipe.db', 'DB'], ['felipe.db-wal', 'WAL'], ['config.json', '{"tavilyKey":"k"}'], ['logs/felipe.log', 'L']]) {
    writeFileSync(join(home, '.felipe', f), v);
  }
  const dir = join(home, '.brain');
  assert.deepEqual(migrateLegacyData(dir, home), [`${join(home, '.felipe')} → ${dir}`, 'felipe.db → brain.db']);
  assert.ok(!existsSync(join(home, '.felipe')));
  assert.equal(readFileSync(join(dir, 'brain.db'), 'utf8'), 'DB');
  assert.equal(readFileSync(join(dir, 'brain.db-wal'), 'utf8'), 'WAL');
  assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), '{"tavilyKey":"k"}');
  assert.ok(existsSync(join(dir, 'logs/brain.log')));
  assert.deepEqual(migrateLegacyData(dir, home), [], 'a second time: nothing to do');
});

test('never over existing data, and never for another folder', () => {
  const home = mkdtempSync(join(tmpdir(), 'brain-rename-'));
  mkdirSync(join(home, '.felipe'));
  writeFileSync(join(home, '.felipe/felipe.db'), 'OLD');
  mkdirSync(join(home, '.brain'));
  writeFileSync(join(home, '.brain/brain.db'), 'NEW');
  assert.deepEqual(migrateLegacyData(join(home, '.brain'), home), []);
  assert.equal(readFileSync(join(home, '.brain/brain.db'), 'utf8'), 'NEW');
  assert.ok(existsSync(join(home, '.felipe/felipe.db')), 'the old folder is left alone, not deleted');
  assert.deepEqual(migrateLegacyData(join(home, 'elsewhere'), home), []);
});

test('the Google connection saved under the old name moves to the new one in the Keychain', async () => {
  const items = new Map<string, string>([['felipe.google', JSON.stringify({ accounts: [{ key: '1', label: 'אישי', email: 'me@gmail.com', refreshToken: 'RT' }] })]]);
  const exec = (async (_file: string, args: string[]) => {
    const service = args[args.indexOf('-s') + 1];
    if (args[0] === 'find-generic-password') {
      if (!items.has(service)) throw new Error('not found');
      return { stdout: args.includes('-w') ? items.get(service)! : '', stderr: '' };
    }
    if (args[0] === 'add-generic-password') items.set(service, args[args.indexOf('-w') + 1]);
    if (args[0] === 'delete-generic-password') items.delete(service);
    return { stdout: '', stderr: '' };
  }) as never;
  const store = keychainStore(exec, 'darwin', mkdtempSync(join(tmpdir(), 'brain-kc-')));
  const got = await store.get();
  assert.equal(got?.accounts[0].refreshToken, 'RT');
  assert.ok(items.has('brain.google'), 'saved under the new name');
  assert.ok(!items.has('felipe.google'), 'and the old one removed');
  assert.equal((await store.get())?.accounts[0].email, 'me@gmail.com');
});
