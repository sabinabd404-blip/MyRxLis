import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config.js';
import { migrate } from '../../scripts/migrate.js';

test('running migrations again on an up-to-date database changes nothing', async () => {
  const applied = await migrate(loadConfig().testDatabaseUrl, () => {});
  assert.deepEqual(applied, []);
});
