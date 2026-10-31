import pg from 'pg';

export type Db = pg.Pool;

export function createPool(connectionString: string): Db {
  return new pg.Pool({ connectionString, max: 10 });
}

/**
 * Run `fn` inside one transaction, recording `actor` for the audit trail.
 * The transaction is rolled back if `fn` throws.
 */
export async function withTransaction<T>(
  db: Db,
  actor: string | null,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    if (actor) {
      await client.query("SELECT set_config('lis.actor', $1, true)", [actor]);
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
