import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDrafts } from '../web/drafts.js';

function device() {
  const items = new Map<string,string>();
  return {
    get length() { return items.size; },
    key: (index: number) => [...items.keys()][index],
    getItem: (key: string) => items.get(key) ?? null,
    removeItem: (key: string) => { items.delete(key); },
    setItem: (key: string, value: string) => { items.set(key, value); },
  };
}

test('drafts survive a cold open separately for each conversation and the new composer', () => {
  const local = device();
  let drafts = createDrafts(local);
  const note = '  טיוטה בעברית\nעוד שורה  ';
  drafts.write('one', note);
  drafts.write('two', 'שנייה');
  drafts.write(null, 'חדשה');
  drafts = createDrafts(local);
  assert.equal(drafts.read('one'), note);
  assert.equal(drafts.read('two'), 'שנייה');
  assert.equal(drafts.read(null), 'חדשה');
  drafts.accepted('one', 'one', note, true);
  assert.equal(drafts.read('one'), '');
  local.setItem('brain.other', 'keep');
  drafts.clear();
  assert.equal(local.length, 1);
  assert.equal(local.getItem('brain.other'), 'keep');
});

test('a late acknowledgement keeps newer typing and a different selected conversation', () => {
  const drafts = createDrafts(device());
  drafts.write(null, 'עוד טקסט');
  drafts.accepted(null, 'one', 'טקסט', true);
  assert.equal(drafts.read('one'), 'עוד טקסט');
  assert.equal(drafts.read(null), '');
  drafts.write(null, 'טיוטה אחרת');
  drafts.accepted(null, 'two', 'טקסט קודם', false);
  assert.equal(drafts.read(null), 'טיוטה אחרת');
  assert.equal(drafts.read('two'), '');
  drafts.accepted('one', 'one', 'גרסה קודמת', true);
  assert.equal(drafts.read('one'), 'עוד טקסט');
});

test('a full device keeps the text in the open composer', () => {
  const local = device();
  local.setItem = () => { throw new Error('quota'); };
  const drafts = createDrafts(local);
  assert.equal(drafts.write(null, 'טיוטה'), false);
  assert.equal(drafts.read(null), 'טיוטה');
  drafts.accepted(null, 'one', 'קודם', true);
  assert.equal(drafts.read('one'), 'טיוטה');
});
