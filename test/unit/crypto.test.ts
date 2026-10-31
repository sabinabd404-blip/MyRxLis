import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bearerToken, hashPassword, hashToken, newApiKey, newSessionToken, verifyPassword } from '../../src/auth/crypto.js';

test('passwords hash with a fresh salt and verify only with the right password', async () => {
  const a = await hashPassword('ঢাকা lab password');
  const b = await hashPassword('ঢাকা lab password');
  assert.notEqual(a, b, 'salted');
  assert.equal(await verifyPassword('ঢাকা lab password', a), true);
  assert.equal(await verifyPassword('ঢাকা lab passwore', a), false);
  assert.equal(await verifyPassword('anything', null), false);
  assert.equal(await verifyPassword('anything', 'plain-text'), false);
  assert.equal(await verifyPassword('anything', 'scrypt$1$1$1$AAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'), false);
});

test('tokens are random, prefixed, and stored only as hashes', () => {
  assert.notEqual(newSessionToken(), newSessionToken());
  const { key, prefix } = newApiKey();
  assert.ok(key.startsWith(`${prefix}_`));
  assert.equal(hashToken(key).length, 32);
  assert.deepEqual(hashToken(key), hashToken(key));
});

test('bearer tokens are read from the Authorization header', () => {
  assert.equal(bearerToken('Bearer abc'), 'abc');
  assert.equal(bearerToken('bearer   abc '), 'abc');
  assert.equal(bearerToken('Basic abc'), null);
  assert.equal(bearerToken(undefined), null);
  assert.equal(bearerToken('Bearer a b'), null);
});
