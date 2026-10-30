import { describe, expect, it } from 'vitest';
import { normalizeAmount, validate } from './format';

describe('normalizeAmount', () => {
  it('normalises money strings', () => {
    expect(normalizeAmount('47.82')).toBe('47.82');
    expect(normalizeAmount('$1,234.5')).toBe('1234.50');
    expect(normalizeAmount('5')).toBe('5.00');
  });
  it('rejects invalid amounts', () => {
    for (const bad of ['', '0', '0.00', '-3', 'abc', '1.234', '1e3', '12345678']) expect(normalizeAmount(bad)).toBeNull();
  });
});

describe('validate', () => {
  const ok = { date: '2026-10-28', amount: '10', description: '', notes: '' };
  it('accepts a valid form', () => expect(validate(ok, '2026-10-30')).toEqual({}));
  it('flags future and missing dates and bad amounts', () => {
    expect(validate({ ...ok, date: '2026-11-02' }, '2026-10-30').date).toBeTruthy();
    expect(validate({ ...ok, date: '' }, '2026-10-30').date).toBeTruthy();
    expect(validate({ ...ok, amount: 'x' }, '2026-10-30').amount).toBeTruthy();
  });
});
