import { join } from 'node:path';
import { loadConfig } from './config.ts';
import { openDb } from './db.ts';
import { createApp, VERSION } from './app.ts';

const config = loadConfig();
const db = openDb(join(config.dataDir, 'brain.db'));
const { server } = createApp(config, db);

server.listen(config.port, config.host, () => {
  console.log(`בריין ${VERSION} מאזין על http://${config.host}:${config.port}`);
  console.log(`תיקיית נתונים: ${config.dataDir}`);

  if (db.activeDeviceCount() === 0) console.log('לצימוד מכשיר ראשון, הרץ npm run pair במק.');
});

const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
