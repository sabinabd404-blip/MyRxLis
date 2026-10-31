/**
 * Pure helpers for age handling, reference-range selection and result flags.
 * Kept free of database access so they can be unit-tested directly.
 */

export interface AgeInput {
  years?: number;
  months?: number;
  days?: number;
}

/**
 * Convert an age as written on a requisition ("35 Y", "6 M", "10 D") to days.
 * Uses 365.25-day years and 30.4375-day months; precise enough for choosing
 * age-banded reference ranges.
 */
export function ageToDays({ years = 0, months = 0, days = 0 }: AgeInput): number {
  for (const v of [years, months, days]) {
    if (!Number.isFinite(v) || v < 0) throw new RangeError('Age parts must be zero or positive numbers');
  }
  return Math.round(years * 365.25 + months * 30.4375 + days);
}

export function ageFromDateOfBirth(dob: Date, on: Date = new Date()): number {
  const ms = on.getTime() - dob.getTime();
  if (ms < 0) throw new RangeError('Date of birth is in the future');
  return Math.floor(ms / 86_400_000);
}

/** Human-readable age for reports, e.g. "35 Y", "7 M", "12 D". */
export function formatAge(ageDays: number): string {
  if (ageDays >= 730) return `${Math.floor(ageDays / 365.25)} Y`;
  if (ageDays >= 31) return `${Math.floor(ageDays / 30.4375)} M`;
  return `${ageDays} D`;
}

export interface RangeRow {
  sex: 'male' | 'female' | null;
  age_min_days: number;
  age_max_days: number | null;
  low: number | null;
  high: number | null;
  critical_low: number | null;
  critical_high: number | null;
  range_text: string | null;
}

/**
 * Choose the reference range for a patient: it must cover the patient's age
 * and match their sex or apply to all; a sex-specific range wins over a
 * general one, then the narrower age band wins.
 */
export function pickRange(ranges: RangeRow[], sex: string, ageDays: number): RangeRow | null {
  const fits = ranges.filter(
    (r) =>
      (r.sex === null || r.sex === sex) &&
      ageDays >= r.age_min_days &&
      (r.age_max_days === null || ageDays <= r.age_max_days),
  );
  fits.sort((a, b) => {
    if ((a.sex === null) !== (b.sex === null)) return a.sex === null ? 1 : -1;
    const span = (r: RangeRow) => (r.age_max_days ?? Number.MAX_SAFE_INTEGER) - r.age_min_days;
    return span(a) - span(b);
  });
  return fits[0] ?? null;
}

export type Flag = 'N' | 'L' | 'H' | 'LL' | 'HH';

/** Flag a numeric value against a range. Returns null when there is nothing to compare. */
export function flagNumeric(value: number, range: RangeRow | null): Flag | null {
  if (!range) return null;
  if (range.critical_low !== null && value < range.critical_low) return 'LL';
  if (range.critical_high !== null && value > range.critical_high) return 'HH';
  if (range.low === null && range.high === null) return null;
  if (range.low !== null && value < range.low) return 'L';
  if (range.high !== null && value > range.high) return 'H';
  return 'N';
}

/** Dhaka calendar date as YYMMDD, used as the period for running numbers. */
export function dhakaPeriod(at: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Dhaka', year: '2-digit', month: '2-digit', day: '2-digit',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}${get('month')}${get('day')}`;
}
