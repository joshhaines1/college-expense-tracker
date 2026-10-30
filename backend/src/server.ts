import path from 'node:path';
import dotenv from 'dotenv';
import { createApp } from './app';
import { googleConfig, loadConfig } from './lib/config';
import { log } from './lib/logger';
import { GoogleDriveStorage } from './services/drive';
import { ExpenseService } from './services/expenseService';
import { createGoogleClients } from './services/google';
import { OcrService } from './services/ocr';
import { GoogleSheetsExpenseSheet } from './services/sheets';
import { FileSubmissionStore } from './services/submissionStore';

// Local development: repo-root .env. In Docker the variables come from compose and no file exists.
dotenv.config({ path: path.resolve(__dirname, '../../.env'), quiet: true });

const config = loadConfig();
const ocr = new OcrService(config.OCR_TIMEOUT_MS);
const google = googleConfig(config);

let expenses: ExpenseService | null = null;
if (google.ok) {
  const clients = createGoogleClients(google.value);
  expenses = new ExpenseService(
    new GoogleDriveStorage(clients.drive, google.value.driveFolderId),
    new GoogleSheetsExpenseSheet(clients.sheets, { spreadsheetId: google.value.spreadsheetId, sheetName: config.SHEET_NAME, firstDataRow: config.FIRST_DATA_ROW }),
    new FileSubmissionStore(config.DATA_DIR),
  );
} else {
  log.warn('Google is not configured; scanning works but saving is disabled', { missing: google.missing.join(',') });
}
if (!config.ALLOWED_TAILSCALE_LOGIN) log.warn('ALLOWED_TAILSCALE_LOGIN is not set; relying on tailnet ACLs alone for access control');

const app = createApp({
  maxUploadBytes: config.MAX_UPLOAD_MB * 1024 * 1024,
  allowedTailscaleLogin: config.ALLOWED_TAILSCALE_LOGIN,
  scanner: ocr,
  expenses,
  missingGoogleConfig: google.ok ? [] : google.missing,
});

const server = app.listen(config.PORT, '0.0.0.0', () => log.info('backend listening', { port: config.PORT }));
server.requestTimeout = 120_000;

async function shutdown(signal: string) {
  log.info('shutting down', { signal });
  server.close();
  await ocr.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (r) => log.error('unhandled rejection', { name: r instanceof Error ? r.name : 'unknown' }));
