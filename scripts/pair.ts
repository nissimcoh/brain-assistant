// Creates a one-time pairing code for a new device (phone, another browser).
// Run on the Mac: npm run pair
import { join } from 'node:path';
import { loadConfig } from '../server/config.ts';
import { openDb } from '../server/db.ts';
import { createAuth } from '../server/auth.ts';

const config = loadConfig();
const db = openDb(join(config.dataDir, 'brain.db'));
const { display, expiresAt } = createAuth(db).newPairingCode();
const until = new Date(expiresAt).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

console.log('');
console.log(`  קוד צימוד:  ${display}`);
console.log(`  תקף עד ${until}, לשימוש אחד בלבד.`);
console.log('');
console.log('  פתח את בריין בטלפון והקלד את הקוד.');
console.log('');
db.close();
