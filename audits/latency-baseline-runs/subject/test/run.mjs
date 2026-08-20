import { strict as assert } from 'node:assert';
import { toCents, formatCents } from '../dist/app/money.js';
import { isExpired, remainingSeconds } from '../dist/lib/session.js';
import { rowClass } from '../dist/components/Row.js';

let passed = 0;
const t = (name, fn) => { fn(); passed += 1; console.log(`  ok   ${name}`); };

t('money: converts to cents', () => assert.equal(toCents(12.34), 1234));
t('money: formats positives', () => assert.equal(formatCents(1234), '12.34'));
t('money: formats negatives', () => assert.equal(formatCents(-505), '-5.05'));
t('money: pads the minor unit', () => assert.equal(formatCents(5), '0.05'));

t('session: fresh session is not expired', () =>
  assert.equal(isExpired({ id: 'a', issuedAt: 1000, ttlSeconds: 60 }, 2000), false));
t('session: old session is expired', () =>
  assert.equal(isExpired({ id: 'a', issuedAt: 1000, ttlSeconds: 60 }, 100000), true));
t('session: remaining never goes negative', () =>
  assert.equal(remainingSeconds({ id: 'a', issuedAt: 0, ttlSeconds: 1 }, 999999), 0));
t('session: remaining counts down', () =>
  assert.equal(remainingSeconds({ id: 'a', issuedAt: 0, ttlSeconds: 60 }, 10000), 50));

t('row: negative rows carry the modifier class', () =>
  assert.equal(rowClass(-1), 'ledger-row ledger-row--negative'));
t('row: positive rows do not', () => assert.equal(rowClass(1), 'ledger-row'));

console.log(`\nsample tests: ${passed} passed, 0 failed`);
