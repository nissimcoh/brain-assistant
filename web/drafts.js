// Store only the composer text on this device. Each conversation has its own
// key so that saving in one tab cannot overwrite another conversation.
const prefix = 'brain.draft.';
const keyFor = id => prefix + (id || 'new');

export function createDrafts(storage) {
  const unsaved = new Map();
  function read(id) {
    const key = keyFor(id);
    if (unsaved.has(key)) return unsaved.get(key);
    try { return storage.getItem(key) ?? ''; }
    catch { return ''; }
  }
  function write(id, text) {
    const key = keyFor(id);
    try {
      if (text) storage.setItem(key, text);
      else storage.removeItem(key);
      unsaved.delete(key);
      return true;
    } catch {
      unsaved.set(key, text);
      return false;
    }
  }
  function accepted(origin, id, submitted, stillHere) {
    const current = read(origin);
    if (current === submitted) write(origin, '');
    else if (!origin && id && current && stillHere) {
      // Keep the original persistent copy if the new key could only be saved in memory.
      if (write(id, current)) write(origin, '');
    }
  }
  function clear() {
    unsaved.clear();
    for (let i = storage.length - 1; i >= 0; i--) {
      const key = storage.key(i);
      if (key?.startsWith(prefix)) storage.removeItem(key);
    }
  }
  return { read, write, accepted, clear };
}
