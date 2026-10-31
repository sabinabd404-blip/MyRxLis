/** Loads db/seeds/demo.sql into DATABASE_URL (run after db:migrate or db:reset). */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../src/config.js';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/seeds/demo.sql');
const client = new pg.Client({ connectionString: loadConfig().databaseUrl });
await client.connect();
try {
  await client.query('BEGIN');
  await client.query(await readFile(file, 'utf8'));
  await client.query('COMMIT');
  console.log('demo data loaded');
} catch (err) {
  await client.query('ROLLBACK');
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
