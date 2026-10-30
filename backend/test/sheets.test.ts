import { describe, expect, it, vi } from 'vitest';
import { GoogleSheetsExpenseSheet } from '../src/services/sheets';
import type { GoogleClients } from '../src/services/google';

const FILE_ID = '1AbCdEfGhIjKlMnOpQrStUv';

/** Fake of the small slice of the Sheets API we use. `table` is what B8:G returns (FORMULA render). */
function fakeSheets(opts: { table: unknown[][]; rowCount?: number; formats?: unknown[]; readBack?: unknown[] }) {
  const batchUpdate = vi.fn(async () => ({}));
  const get = vi.fn(async (args: { ranges?: string[] }) => {
    if (args.ranges) {
      return { data: { sheets: [{ data: (opts.formats ?? [{}, {}]).map((numberFormat) => ({ rowData: [{ values: [{ effectiveFormat: { numberFormat } }] }] })) }] } };
    }
    return { data: { sheets: [{ properties: { sheetId: 42, title: 'Sheet1', gridProperties: { rowCount: opts.rowCount ?? 1000 } } }] } };
  });
  const valuesGet = vi.fn(async (args: { valueRenderOption: string }) => ({
    data: { values: args.valueRenderOption === 'FORMULA' ? opts.table : (opts.readBack ?? [[46324, '', 'Groceries', 47.82]]) },
  }));
  const client = { spreadsheets: { get, batchUpdate, values: { get: valuesGet } } } as unknown as GoogleClients['sheets'];
  return { client, batchUpdate, valuesGet };
}

const expense = { date: '2026-10-29', description: '=HYPERLINK("http://evil","x")', category: 'Groceries' as const, amount: 47.82, receiptFileId: FILE_ID, notes: '@SUM(1)' };
const opts = { spreadsheetId: 'SID', sheetName: 'Sheet1', firstDataRow: 8 };
const requests = (b: ReturnType<typeof vi.fn>) => (b.mock.calls[0]![0] as { requestBody: { requests: any[] } }).requestBody.requests;

describe('GoogleSheetsExpenseSheet', () => {
  it('writes typed cells to the first unused row without touching anything else', async () => {
    const f = fakeSheets({ table: [['a', '', 'Rent', 1], ['b', '', 'Groceries', 2], []], formats: [{ type: 'DATE', pattern: 'm/d/yyyy' }, { type: 'CURRENCY', pattern: '$#,##0.00' }] });
    const r = await new GoogleSheetsExpenseSheet(f.client, opts).appendExpense(expense);
    expect(r).toEqual({ row: 10, alreadyPresent: false });
    const reqs = requests(f.batchUpdate);
    expect(reqs).toHaveLength(6); // B..G only; no insert/append
    const cells = reqs.map((q) => ({ col: q.updateCells.range.startColumnIndex, row: q.updateCells.range.startRowIndex, v: q.updateCells.rows[0].values[0] }));
    expect(cells.every((c) => c.row === 9)).toBe(true); // 0-based index of sheet row 10
    expect(cells.map((c) => c.col)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(cells[0]!.v.userEnteredValue).toEqual({ numberValue: 46324 });
    expect(cells[0]!.v.userEnteredFormat).toBeUndefined(); // existing date format retained
    expect(cells[3]!.v.userEnteredValue).toEqual({ numberValue: 47.82 });
    expect(cells[4]!.v.userEnteredValue).toEqual({ formulaValue: `=HYPERLINK("https://drive.google.com/file/d/${FILE_ID}/view", "Receipt Link")` });
    // user text is only ever a stringValue — never a formulaValue
    expect(cells[1]!.v.userEnteredValue).toEqual({ stringValue: expense.description });
    expect(cells[5]!.v.userEnteredValue).toEqual({ stringValue: '@SUM(1)' });
    expect(reqs.filter((q) => q.updateCells.rows[0].values[0].userEnteredValue.formulaValue)).toHaveLength(1);
    // never touches the summary rows above the table
    expect(Math.min(...cells.map((c) => c.row))).toBeGreaterThanOrEqual(7);
  });

  it('applies date/currency formats only when the cells lack them', async () => {
    const f = fakeSheets({ table: [], formats: [{}, { type: 'NUMBER', pattern: '#,##0.###' }] });
    await new GoogleSheetsExpenseSheet(f.client, opts).appendExpense(expense);
    const reqs = requests(f.batchUpdate);
    expect(reqs[0].updateCells.rows[0].values[0].userEnteredFormat.numberFormat.type).toBe('DATE');
    expect(reqs[3].updateCells.rows[0].values[0].userEnteredFormat.numberFormat.type).toBe('CURRENCY');
  });

  it('grows the grid and copies format + validation from the row above when the table fills it', async () => {
    const full = Array.from({ length: 3 }, () => ['x', '', 'Rent', 1]); // rows 8-10; grid has exactly 10 rows
    const f = fakeSheets({ table: full, rowCount: 10 });
    const r = await new GoogleSheetsExpenseSheet(f.client, opts).appendExpense(expense);
    expect(r.row).toBe(11);
    const reqs = requests(f.batchUpdate);
    expect(reqs[0]).toEqual({ appendDimension: { sheetId: 42, dimension: 'ROWS', length: 1 } });
    expect(reqs.slice(1, 3).map((q) => q.copyPaste.pasteType)).toEqual(['PASTE_FORMAT', 'PASTE_DATA_VALIDATION']);
    expect(reqs[1].copyPaste.source.startRowIndex).toBe(9);
    expect(reqs[1].copyPaste.destination.startRowIndex).toBe(10);
  });

  it('does not write again when this receipt is already in the sheet', async () => {
    const link = `=HYPERLINK("https://drive.google.com/file/d/${FILE_ID}/view", "Receipt Link")`;
    const f = fakeSheets({ table: [['d', '', 'Groceries', 1, link]] });
    const r = await new GoogleSheetsExpenseSheet(f.client, opts).appendExpense(expense);
    expect(r).toEqual({ row: 8, alreadyPresent: true });
    expect(f.batchUpdate).not.toHaveBeenCalled();
  });

  it('fails loudly if the read-back shows the value was not stored as a number/date', async () => {
    const f = fakeSheets({ table: [], readBack: [['2026-10-29', '', 'Groceries', '47.82']] });
    await expect(new GoogleSheetsExpenseSheet(f.client, opts).appendExpense(expense)).rejects.toMatchObject({ code: 'sheet_verify_failed' });
  });

  it('serialises concurrent writes so two receipts never pick the same row', async () => {
    let table: unknown[][] = [];
    const f = fakeSheets({ table });
    f.valuesGet.mockImplementation(async (args: { valueRenderOption: string }) => ({ data: { values: args.valueRenderOption === 'FORMULA' ? table : [[46324, '', 'Groceries', 47.82]] } }));
    f.batchUpdate.mockImplementation(async () => {
      table = [...table, ['d', '', 'Groceries', 1]];
      return {};
    });
    const sheet = new GoogleSheetsExpenseSheet(f.client, opts);
    const [a, b] = await Promise.all([sheet.appendExpense(expense), sheet.appendExpense({ ...expense, receiptFileId: '2ZzYyXxWwVvUuTtSsRrQq' })]);
    expect([a.row, b.row].sort()).toEqual([8, 9]);
  });
});
