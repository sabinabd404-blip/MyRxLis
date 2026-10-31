/** Loads every db/seeds/*.sql file (in name order) into DATABASE_URL. Run after db:migrate or db:reset. */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadConfig } from '../src/config.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../db/seeds');
const client = new pg.Client({ connectionString: loadConfig().databaseUrl });
await client.connect();
try {
  await client.query('BEGIN');
  for (const file of (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()) {
    await client.query(await readFile(path.join(dir, file), 'utf8'));
    console.log(`loaded ${file}`);
  }
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await client.end();
}
