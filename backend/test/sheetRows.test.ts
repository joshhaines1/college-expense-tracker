import { describe, expect, it } from 'vitest';
import { findBoundedRangesMissingRow, findFirstUnusedRow, findRowForFile, isoDateToSerial } from '../src/services/sheetRows';

describe('findFirstUnusedRow', () => {
  it('returns the first row when the table is empty', () => {
    expect(findFirstUnusedRow([], 8)).toBe(8);
    expect(findFirstUnusedRow(undefined, 8)).toBe(8);
  });

  it('returns the row after the last used row', () => {
    const v = [
      ['2026-10-01', 'Rent', 'Rent', 900, '', ''],
      ['2026-10-02', '', 'Groceries', 40, '=HYPERLINK("x","Receipt Link")'],
    ];
    expect(findFirstUnusedRow(v, 8)).toBe(10);
  });

  it('picks the first genuinely blank row, not a position after pre-formatted blanks', () => {
    // Rows 8-9 used, rows 10-12 are formatted blanks returned as [] or empty strings, row 13 used again.
    const v = [['a', '', 'Rent', 1], ['b', '', 'Groceries', 2], [], ['', '', '', '', '', ''], [], ['c', '', 'Rent', 3]];
    expect(findFirstUnusedRow(v, 8)).toBe(10);
  });

  it('treats whitespace-only cells as blank but formulas as used', () => {
    expect(findFirstUnusedRow([['  ', '', ' ']], 8)).toBe(8);
    expect(findFirstUnusedRow([['', '', '', '=IF(1=2,1,"")']], 8)).toBe(9);
  });

  it('respects a non-default first data row', () => {
    expect(findFirstUnusedRow([['x']], 3)).toBe(4);
  });
});

describe('findRowForFile', () => {
  const link = (id: string) => `=HYPERLINK("https://drive.google.com/file/d/${id}/view", "Receipt Link")`;
  it('finds the row already referencing a Drive file (idempotent retry)', () => {
    const v = [['d', '', 'Groceries', 1, link('AAA')], ['d', '', 'Groceries', 2, link('BBB')]];
    expect(findRowForFile(v, 8, 'BBB')).toBe(9);
    expect(findRowForFile(v, 8, 'CCC')).toBeNull();
  });
});

describe('isoDateToSerial', () => {
  it('matches known Sheets serials', () => {
    expect(isoDateToSerial('1899-12-30')).toBe(0);
    expect(isoDateToSerial('2000-01-01')).toBe(36526);
    expect(isoDateToSerial('2026-10-30')).toBe(46325);
  });
  it('rejects impossible dates', () => {
    expect(() => isoDateToSerial('2026-02-30')).toThrow();
    expect(() => isoDateToSerial('10/30/2026')).toThrow();
  });
});

describe('findBoundedRangesMissingRow', () => {
  it('flags ranges that stop before the new row, ignores open ones', () => {
    const issues = findBoundedRangesMissingRow(
      [
        { cell: 'B5', formula: '=SUM(E8:E20)' },
        { cell: 'C5', formula: '=SUMIF(D8:D,"Groceries",E8:E)' },
        { cell: 'D5', formula: '=SUM(E:E)' },
        { cell: 'E5', formula: '=SUM(Z1:Z3)' },
      ],
      21,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ cell: 'B5', range: 'E8:E20', lastRow: 20 });
  });
});
