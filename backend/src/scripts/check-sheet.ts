/**
 * Read-only configuration check. Writes nothing to your spreadsheet or Drive.
 *   npm run check-sheet                      (on the Mac)
 *   docker compose run --rm backend node dist/scripts/check-sheet.js   (on the server)
 */
import { createGoogleClients } from '../services/google';
import { findBoundedRangesMissingRow, findFirstUnusedRow, type CellValue } from '../services/sheetRows';
import { quoteSheetName } from '../services/sheets';
import { fail, loadScriptConfig, requireGoogle } from './env';

const EXPECTED_HEADERS = ['Date', 'Description', 'Category', 'Amount', 'Receipt Link', 'Notes'];
const ok = (m: string) => console.log(`✓ ${m}`);
const warn = (m: string) => console.log(`! ${m}`);

async function main() {
  const cfg = loadScriptConfig();
  const g = requireGoogle(cfg);
  const { sheets, drive } = createGoogleClients(g);
  const name = cfg.SHEET_NAME;
  const q = quoteSheetName(name);
  const first = cfg.FIRST_DATA_ROW;
  const headerRow = first - 1;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: g.spreadsheetId, fields: 'properties.title,sheets.properties(title,gridProperties(rowCount))' });
  ok(`Spreadsheet reachable: "${meta.data.properties?.title}"`);
  const tab = meta.data.sheets?.find((s) => s.properties?.title === name);
  if (!tab) fail(`No tab named "${name}". Tabs found: ${(meta.data.sheets ?? []).map((s) => s.properties?.title).join(', ')}`);
  const rowCount = tab.properties?.gridProperties?.rowCount ?? 0;
  ok(`Tab "${name}" found (${rowCount} grid rows)`);

  const top = await sheets.spreadsheets.values.get({ spreadsheetId: g.spreadsheetId, range: `${q}!A1:Z${headerRow}`, valueRenderOption: 'FORMULA' });
  const rows = (top.data.values ?? []) as CellValue[][];
  const headers = (rows[headerRow - 1] ?? []).slice(1, 7).map((h) => String(h ?? '').trim());
  if (EXPECTED_HEADERS.every((h, i) => headers[i]?.toLowerCase() === h.toLowerCase())) ok(`Header row ${headerRow} matches B:G = ${EXPECTED_HEADERS.join(' | ')}`);
  else warn(`Header row ${headerRow} (B:G) is [${headers.join(' | ')}], expected [${EXPECTED_HEADERS.join(' | ')}]. Check FIRST_DATA_ROW.`);

  const table = await sheets.spreadsheets.values.get({ spreadsheetId: g.spreadsheetId, range: `${q}!B${first}:G`, valueRenderOption: 'FORMULA' });
  const next = findFirstUnusedRow((table.data.values ?? []) as CellValue[][], first);
  ok(`First unused transaction row: ${next}${next > rowCount ? ' (grid will be extended with formatting copied from the row above)' : ''}`);

  const formulas: { cell: string; formula: string }[] = [];
  rows.slice(0, headerRow - 1).forEach((row, r) =>
    row.forEach((v, c) => {
      if (typeof v === 'string' && v.startsWith('=')) formulas.push({ cell: `${String.fromCharCode(65 + c)}${r + 1}`, formula: v });
    }),
  );
  console.log(`\nDashboard formulas above the table (${formulas.length}):`);
  formulas.forEach((f) => console.log(`  ${f.cell}: ${f.formula}`));
  const issues = findBoundedRangesMissingRow(formulas, next);
  if (issues.length) {
    console.log('');
    issues.forEach((i) => warn(`${i.cell} uses ${i.range}, which ends at row ${i.lastRow}: transactions at row ${i.lastRow + 1} or beyond would NOT be counted. Widen it (e.g. to ${i.range.replace(/\d+$/, '')}) in the sheet.`));
  } else ok('No bounded dashboard ranges that would exclude new rows');

  try {
    const f = await drive.files.get({ fileId: g.driveFolderId, fields: 'name,mimeType,trashed' });
    if (f.data.mimeType !== 'application/vnd.google-apps.folder' || f.data.trashed) warn('DRIVE_FOLDER_ID is not an active folder.');
    else ok(`Drive folder reachable: "${f.data.name}"`);
  } catch {
    warn('Drive folder is not accessible to this app. With the drive.file scope the folder must be created by `npm run setup:folder`.');
  }
  console.log('\nDone. Nothing was modified.');
}

main().catch((e: Error) => fail(`Check failed: ${e.message}`));
