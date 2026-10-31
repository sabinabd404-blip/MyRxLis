import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageToDays, dhakaPeriod, flagNumeric, formatAge, pickRange, type RangeRow } from '../../src/lis/clinical.js';

const range = (r: Partial<RangeRow>): RangeRow => ({
  sex: null, age_min_days: 0, age_max_days: null, low: null, high: null,
  critical_low: null, critical_high: null, range_text: null, ...r,
});

test('ages convert to days and back to the form printed on reports', () => {
  assert.equal(ageToDays({ years: 35 }), 12784);
  assert.equal(ageToDays({ months: 6 }), 183);
  assert.equal(ageToDays({ days: 10 }), 10);
  assert.equal(formatAge(12784), '35 Y');
  assert.equal(formatAge(183), '6 M');
  assert.equal(formatAge(10), '10 D');
  assert.throws(() => ageToDays({ years: -1 }), RangeError);
});

test('a sex-specific range wins over a general one, then the narrower age band', () => {
  const general = range({ low: 12, high: 17 });
  const female = range({ sex: 'female', low: 12, high: 15.5 });
  const child = range({ age_min_days: 0, age_max_days: 4380, low: 11, high: 14 });
  assert.equal(pickRange([general, female], 'female', 12000), female);
  assert.equal(pickRange([general, female], 'male', 12000), general);
  assert.equal(pickRange([general, child], 'male', 2000), child);
  assert.equal(pickRange([child], 'male', 12000), null);
});

test('numeric values are flagged against the range, critical limits first', () => {
  const r = range({ low: 3.9, high: 5.5, critical_low: 2.2, critical_high: 25 });
  assert.equal(flagNumeric(5.0, r), 'N');
  assert.equal(flagNumeric(3.0, r), 'L');
  assert.equal(flagNumeric(7.2, r), 'H');
  assert.equal(flagNumeric(2.0, r), 'LL');
  assert.equal(flagNumeric(30, r), 'HH');
  assert.equal(flagNumeric(250, range({ high: 200 })), 'H');
  assert.equal(flagNumeric(5, null), null);
  assert.equal(flagNumeric(5, range({ range_text: 'Negative' })), null);
});

test('running-number periods follow the Dhaka calendar day', () => {
  assert.equal(dhakaPeriod(new Date('2026-10-31T17:59:00Z')), '261031');
  assert.equal(dhakaPeriod(new Date('2026-10-31T18:01:00Z')), '261101');
});
