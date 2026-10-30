import { describe, expect, it } from 'vitest';
import { extractDate, extractTotal, findAmounts, parseReceipt } from '../src/services/receiptParser';

const TODAY = '2026-10-30';

describe('findAmounts', () => {
  it('handles currency symbols, thousands separators and OCR comma decimals', () => {
    expect(findAmounts('TOTAL $1,234.56').map((a) => a.value)).toEqual([1234.56]);
    expect(findAmounts('TOTAL 47,82').map((a) => a.value)).toEqual([47.82]);
    expect(findAmounts('TOTAL 47. 82').map((a) => a.value)).toEqual([47.82]);
  });
  it('ignores long digit runs and flags negatives', () => {
    expect(findAmounts('UPC 0123456789012')).toEqual([]);
    expect(findAmounts('COUPON 2.00-')[0]?.negative).toBe(true);
    expect(findAmounts('-3.50')[0]?.negative).toBe(true);
  });
});

describe('extractTotal', () => {
  it('picks TOTAL, not SUBTOTAL, tax, tender or change', () => {
    const text = `WALMART SUPERCENTER
MILK 1GAL        3.48
BREAD            2.50
SUBTOTAL         5.98
TAX 1  6.5%      0.39
TOTAL            6.37
VISA TEND        10.00
CHANGE DUE       3.63`;
    const r = extractTotal(text);
    expect(r.total).toBe(6.37);
    expect(r.status).toBe('ok');
  });

  it('prefers GRAND TOTAL / AMOUNT PAID over a plain TOTAL', () => {
    const r = extractTotal('TOTAL 40.00\nGRAND TOTAL 47.82\n');
    expect(r.total).toBe(47.82);
  });

  it('ignores TOTAL SAVINGS and TOTAL ITEMS lines', () => {
    const r = extractTotal('TOTAL SAVINGS 7.10\nTOTAL ITEMS SOLD 12\nTOTAL 47.82');
    expect(r.total).toBe(47.82);
    expect(r.status).toBe('ok');
  });

  it('reads an amount placed on the line after the label', () => {
    expect(extractTotal('SUBTOTAL 10.00\nTOTAL\n$10.80\n').total).toBe(10.8);
  });

  it('falls back to a card tender line with an uncertain status', () => {
    const r = extractTotal('MILK 3.48\nDEBIT CARD 3.48');
    expect(r.total).toBe(3.48);
    expect(r.status).toBe('uncertain');
  });

  it('reports missing when nothing plausible exists', () => {
    const r = extractTotal('THANK YOU FOR SHOPPING');
    expect(r.total).toBeNull();
    expect(r.status).toBe('missing');
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('flags multiple conflicting totals and total below subtotal', () => {
    expect(extractTotal('TOTAL 10.00\nTOTAL 12.00').status).toBe('uncertain');
    expect(extractTotal('SUBTOTAL 50.00\nTOTAL 20.00').status).toBe('uncertain');
  });

  it('warns about refunds', () => {
    expect(extractTotal('REFUND\nTOTAL 5.00').warnings.join(' ')).toMatch(/refund/i);
  });

  it('rejects implausibly large amounts', () => {
    expect(extractTotal('TOTAL 99999.99').total).toBeNull();
  });
});

describe('extractDate', () => {
  it('parses common US receipt formats', () => {
    expect(extractDate('10/28/2026 14:03', TODAY).date).toBe('2026-10-28');
    expect(extractDate('10/28/26', TODAY).date).toBe('2026-10-28');
    expect(extractDate('2026-10-28', TODAY).date).toBe('2026-10-28');
    expect(extractDate('Oct 28, 2026', TODAY).date).toBe('2026-10-28');
    expect(extractDate('28 Oct 2026', TODAY).date).toBe('2026-10-28');
  });
  it('falls back to D/M/Y when the first part is not a month', () => {
    expect(extractDate('28/10/2026', TODAY).date).toBe('2026-10-28');
  });
  it('skips expiry lines and future dates', () => {
    expect(extractDate('EXP 12/31/2026\n10/28/2026', TODAY).date).toBe('2026-10-28');
    expect(extractDate('12/31/2026', TODAY).date).toBeNull();
  });
  it('rejects impossible dates and times', () => {
    expect(extractDate('13/45/2026', TODAY).date).toBeNull();
    expect(extractDate('10.42.31', TODAY).date).toBeNull();
  });
  it('marks several different dates as uncertain', () => {
    const r = extractDate('10/28/2026\n10/20/2026', TODAY);
    expect(r.date).toBe('2026-10-28');
    expect(r.status).toBe('uncertain');
  });
  it('reports missing', () => {
    expect(extractDate('no date', TODAY).status).toBe('missing');
  });
});

describe('parseReceipt', () => {
  it('combines date, total and warnings', () => {
    const r = parseReceipt('10/28/2026\nTOTAL 47.82', TODAY);
    expect(r).toMatchObject({ date: '2026-10-28', total: 47.82, dateStatus: 'ok', totalStatus: 'ok', warnings: [] });
  });
});
