/**
 * Credential admin from the command line (for the first admin and the first API keys).
 *
 *   npm run auth -- set-password <LAB_CODE> <username>          password read from stdin
 *   npm run auth -- create-api-key <ORG_CODE> <user> "<name>"   user = users.id or external_user_ref
 *   npm run auth -- list-api-keys <ORG_CODE>
 *   npm run auth -- revoke-api-key <ORG_CODE> <key id or mrxk_ prefix>
 *
 * Uses DATABASE_URL. An API key is printed once and cannot be shown again.
 */
import { createInterface } from 'node:readline/promises';
import { createKey, listKeys, revokeKey } from '../src/auth/dx-auth.js';
import { setPasswordByUsername } from '../src/auth/lis-auth.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';

const [cmd, ...args] = process.argv.slice(2);
const db = createPool(loadConfig().databaseUrl);

async function readPassword(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: false });
  if (process.stdin.isTTY) process.stderr.write('New password (input is visible; prefer piping it in): ');
  for await (const line of rl) { rl.close(); return line; }
  throw new Error('No password given on stdin');
}

async function orgId(code: string): Promise<string> {
  const { rows: [o] } = await db.query<{ id: string }>('SELECT id FROM organisations WHERE organisation_code = $1', [code]);
  if (!o) throw new Error(`No organisation with code ${code}`);
  return o.id;
}

function usage(): never {
  console.error('Usage: npm run auth -- set-password <LAB_CODE> <username> | create-api-key <ORG_CODE> <user> "<name>" | list-api-keys <ORG_CODE> | revoke-api-key <ORG_CODE> <key>');
  process.exit(2);
}

try {
  if (cmd === 'set-password' && args.length === 2) {
    const [lab, username] = args as [string, string];
    await setPasswordByUsername(db, lab, username, await readPassword());
    console.log(`Password set for ${username} in ${lab}; their existing sessions were signed out.`);
  } else if (cmd === 'create-api-key' && args.length === 3) {
    const [code, user, name] = args as [string, string, string];
    const org = await orgId(code);
    const { rows: [u] } = await db.query<{ id: string }>(
      `SELECT id FROM users WHERE id::text = $1 OR external_user_ref = $1`, [user]);
    if (!u) throw new Error(`No user ${user}`);
    const key = await createKey(db, org, { user_id: u.id, name }, null);
    console.log(`API key ${key.key_prefix} for ${code} (id ${key.id}). Store it now; it is not shown again:\n\n${key.key}\n`);
  } else if (cmd === 'list-api-keys' && args.length === 1) {
    console.table(await listKeys(db, await orgId(args[0]!)));
  } else if (cmd === 'revoke-api-key' && args.length === 2) {
    const org = await orgId(args[0]!);
    const { rows: [k] } = await db.query<{ id: string }>(
      'SELECT id FROM dx_api_keys WHERE organisation_id = $1 AND (id::text = $2 OR key_prefix = $2)', [org, args[1]]);
    if (!k) throw new Error(`No key ${args[1]} in ${args[0]}`);
    const r = await revokeKey(db, org, k.id, null);
    console.log(`Revoked ${r.key_prefix}`);
  } else {
    usage();
  }
} catch (err) {
  console.error((err as Error).message);
  process.exitCode = 1;
} finally {
  await db.end();
}
