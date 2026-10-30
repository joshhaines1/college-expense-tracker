/** Pure helpers for locating rows in the transaction table. Kept free of Google SDK types for easy testing. */

export type CellValue = string | number | boolean | null | undefined;

function isBlank(v: CellValue): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/**
 * `values` is the result of reading `B{firstRow}:G` with valueRenderOption=FORMULA.
 * The API trims trailing empty rows/cells, and returns [] for fully empty rows in between.
 *
 * Returns the 1-based sheet row of the first row whose B:G cells are all empty. Using FORMULA rendering
 * means a cell holding a formula that currently evaluates to "" still counts as used, so we never
 * overwrite a formula. If every returned row is used, the next row after the data is returned
 * (which may be beyond the sheet's current grid — the caller adds a row then).
 */
export function findFirstUnusedRow(values: CellValue[][] | null | undefined, firstRow: number): number {
  const rows = values ?? [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] ?? [];
    if (row.every(isBlank)) return firstRow + i;
  }
  return firstRow + rows.length;
}

/** Returns the 1-based row whose Receipt Link (column F, index 4 within B:G) references this Drive file, if any. */
export function findRowForFile(values: CellValue[][] | null | undefined, firstRow: number, fileId: string): number | null {
  const rows = values ?? [];
  for (let i = 0; i < rows.length; i++) {
    const cell = rows[i]?.[4];
    if (typeof cell === 'string' && cell.includes(`/file/d/${fileId}/`)) return firstRow + i;
  }
  return null;
}

/** Google Sheets serial date number (days since 1899-12-30) for a YYYY-MM-DD string. */
export function isoDateToSerial(iso: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) throw new Error('Invalid ISO date');
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const check = new Date(ms);
  if (check.getUTCFullYear() !== Number(m[1]) || check.getUTCMonth() !== Number(m[2]) - 1 || check.getUTCDate() !== Number(m[3])) {
    throw new Error('Invalid ISO date');
  }
  return Math.round((ms - Date.UTC(1899, 11, 30)) / 86_400_000);
}

export function columnToIndex(col: string): number {
  return [...col.toUpperCase()].reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0) - 1;
}

export interface FormulaRangeIssue {
  cell: string;
  formula: string;
  range: string;
  lastRow: number;
}

/**
 * Finds bounded ranges (e.g. E8:E200) in dashboard formulas that end before `nextRow`, meaning the new
 * transaction would not be counted. Open-ended (E8:E) and whole-column (E:E) references are fine.
 */
export function findBoundedRangesMissingRow(
  formulas: { cell: string; formula: string }[],
  nextRow: number,
  tableColumns: string[] = ['B', 'C', 'D', 'E', 'F', 'G'],
): FormulaRangeIssue[] {
  const issues: FormulaRangeIssue[] = [];
  const re = /\$?([A-Z]{1,2})\$?(\d+):\$?([A-Z]{1,2})\$?(\d+)/g;
  for (const { cell, formula } of formulas) {
    for (const m of formula.matchAll(re)) {
      const [range, c1, , c2, r2] = m;
      if (!tableColumns.includes(c1!) && !tableColumns.includes(c2!)) continue;
      const lastRow = Number(r2);
      if (lastRow < nextRow) issues.push({ cell, formula, range: range!, lastRow });
    }
  }
  return issues;
}
