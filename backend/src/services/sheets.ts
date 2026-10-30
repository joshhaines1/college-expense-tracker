import type { sheets_v4 } from 'googleapis';
import { AppError, mapGoogleError } from '../lib/errors';
import { Mutex } from '../lib/mutex';
import { receiptUrl } from './drive';
import type { GoogleClients } from './google';
import { findFirstUnusedRow, findRowForFile, isoDateToSerial, type CellValue } from './sheetRows';

export interface ExpenseRow {
  date: string; // YYYY-MM-DD
  description: string;
  category: 'Groceries';
  amount: number;
  receiptFileId: string;
  notes: string;
}

export interface ExpenseSheet {
  /** Writes the row to the first unused transaction row (or returns the existing row for this receipt). */
  appendExpense(row: ExpenseRow): Promise<{ row: number; alreadyPresent: boolean }>;
}

export interface SheetsOptions {
  spreadsheetId: string;
  sheetName: string;
  firstDataRow: number;
}

const COLS = { B: 1, C: 2, D: 3, E: 4, F: 5, G: 6 } as const;
const DATE_PATTERN = 'yyyy-mm-dd';
const CURRENCY_PATTERN = '$#,##0.00';

export function quoteSheetName(name: string): string {
  return `'${name.replace(/'/g, "''")}'`;
}

/** Always a literal string — never interpreted as a formula by the Sheets API (it goes in stringValue). */
function text(v: string): sheets_v4.Schema$ExtendedValue {
  return v === '' ? {} : { stringValue: v };
}

export class GoogleSheetsExpenseSheet implements ExpenseSheet {
  // Single backend instance: serialising here makes read-modify-write of "first free row" safe.
  private readonly lock = new Mutex();

  constructor(
    private readonly sheets: GoogleClients['sheets'],
    private readonly opts: SheetsOptions,
  ) {}

  appendExpense(row: ExpenseRow): Promise<{ row: number; alreadyPresent: boolean }> {
    return this.lock.run(() => this.appendLocked(row)).catch((err) => {
      throw mapGoogleError(err, 'write to the spreadsheet');
    });
  }

  private async appendLocked(expense: ExpenseRow): Promise<{ row: number; alreadyPresent: boolean }> {
    const { spreadsheetId, sheetName, firstDataRow } = this.opts;
    const q = quoteSheetName(sheetName);

    const meta = await this.sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets.properties(sheetId,title,gridProperties(rowCount))',
    });
    const sheet = meta.data.sheets?.find((s) => s.properties?.title === sheetName)?.properties;
    if (!sheet || sheet.sheetId == null) {
      throw new AppError(502, 'sheet_tab_missing', `The spreadsheet has no tab named "${sheetName}".`);
    }
    const sheetId = sheet.sheetId;
    const rowCount = sheet.gridProperties?.rowCount ?? 1000;

    const read = await this.sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${q}!B${firstDataRow}:G`,
      valueRenderOption: 'FORMULA',
    });
    const values = (read.data.values ?? []) as CellValue[][];

    // Retry safety: if a previous attempt already wrote this receipt, do not write it again.
    const existing = findRowForFile(values, firstDataRow, expense.receiptFileId);
    if (existing !== null) return { row: existing, alreadyPresent: true };

    const target = findFirstUnusedRow(values, firstDataRow);
    const requests: sheets_v4.Schema$Request[] = [];

    if (target > rowCount) {
      // The table fills the grid to the bottom: grow it and copy formatting + dropdown validation
      // (never values/formulas) from the row above.
      requests.push(
        { appendDimension: { sheetId, dimension: 'ROWS', length: target - rowCount } },
        {
          copyPaste: {
            source: { sheetId, startRowIndex: target - 2, endRowIndex: target - 1, startColumnIndex: 0, endColumnIndex: 7 },
            destination: { sheetId, startRowIndex: target - 1, endRowIndex: target, startColumnIndex: 0, endColumnIndex: 7 },
            pasteType: 'PASTE_FORMAT',
          },
        },
        {
          copyPaste: {
            source: { sheetId, startRowIndex: target - 2, endRowIndex: target - 1, startColumnIndex: 0, endColumnIndex: 7 },
            destination: { sheetId, startRowIndex: target - 1, endRowIndex: target, startColumnIndex: 0, endColumnIndex: 7 },
            pasteType: 'PASTE_DATA_VALIDATION',
          },
        },
      );
    }

    // Only override number formats when the destination cells would otherwise show a raw serial/number.
    const formatRow = Math.min(target, rowCount);
    const fmt = await this.sheets.spreadsheets.get({
      spreadsheetId,
      ranges: [`${q}!B${formatRow}`, `${q}!E${formatRow}`],
      fields: 'sheets.data.rowData.values.effectiveFormat.numberFormat',
    });
    const cellFormats = (fmt.data.sheets?.[0]?.data ?? []).map((d) => d.rowData?.[0]?.values?.[0]?.effectiveFormat?.numberFormat);
    const dateFmt = cellFormats[0];
    const amountFmt = cellFormats[1];
    const dateOk = dateFmt?.type === 'DATE' || dateFmt?.type === 'DATE_TIME';
    const amountOk = amountFmt?.type === 'CURRENCY' || (amountFmt?.type === 'NUMBER' && /0\.00/.test(amountFmt.pattern ?? ''));

    const cell = (
      col: keyof typeof COLS,
      value: sheets_v4.Schema$ExtendedValue,
      numberFormat?: sheets_v4.Schema$NumberFormat,
    ): sheets_v4.Schema$Request => ({
      updateCells: {
        range: { sheetId, startRowIndex: target - 1, endRowIndex: target, startColumnIndex: COLS[col], endColumnIndex: COLS[col] + 1 },
        rows: [{ values: [numberFormat ? { userEnteredValue: value, userEnteredFormat: { numberFormat } } : { userEnteredValue: value }] }],
        fields: numberFormat ? 'userEnteredValue,userEnteredFormat.numberFormat' : 'userEnteredValue',
      },
    });

    const amount = Math.round(expense.amount * 100) / 100;
    requests.push(
      cell('B', { numberValue: isoDateToSerial(expense.date) }, dateOk ? undefined : { type: 'DATE', pattern: DATE_PATTERN }),
      cell('C', text(expense.description)),
      cell('D', text(expense.category)),
      cell('E', { numberValue: amount }, amountOk ? undefined : { type: 'CURRENCY', pattern: CURRENCY_PATTERN }),
      // receiptUrl() only ever emits https://drive.google.com/file/d/<[A-Za-z0-9_-]+>/view, so the formula cannot be broken out of.
      cell('F', { formulaValue: `=HYPERLINK("${receiptUrl(expense.receiptFileId)}", "Receipt Link")` }),
      cell('G', text(expense.notes)),
    );

    await this.sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });

    // Read back and verify the cells were stored with the intended types.
    const check = await this.sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${q}!B${target}:G${target}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const got = (check.data.values?.[0] ?? []) as CellValue[];
    if (got[0] !== isoDateToSerial(expense.date) || got[2] !== expense.category || got[3] !== amount) {
      throw new AppError(502, 'sheet_verify_failed', `The row written at ${sheetName}!${target} did not read back correctly (date/amount not stored as a date/number). Check the sheet before retrying.`);
    }
    return { row: target, alreadyPresent: false };
  }
}
