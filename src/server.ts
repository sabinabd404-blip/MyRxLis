import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const app = buildApp({ db, logger: true });

const shutdown = async () => {
  await app.close();
  await db.end();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: config.port, host: '0.0.0.0' });
