/**
 * Creates the Drive folder that receipts are uploaded into. With the least-privilege `drive.file` scope the app can
 * only use folders it created itself, so create it here rather than by hand in the Drive UI.
 *   npm run setup:folder -- "College Expenses Receipts"
 * The folder stays PRIVATE; only individual receipt files are link-shared.
 */
import { google } from 'googleapis';
import { createOAuthClient } from '../services/google';
import { fail, loadScriptConfig } from './env';

async function main() {
  const cfg = loadScriptConfig();
  if (!cfg.GOOGLE_CLIENT_ID || !cfg.GOOGLE_CLIENT_SECRET || !cfg.GOOGLE_REFRESH_TOKEN) fail('Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and GOOGLE_REFRESH_TOKEN in .env first.');
  const auth = createOAuthClient(cfg.GOOGLE_CLIENT_ID, cfg.GOOGLE_CLIENT_SECRET);
  auth.setCredentials({ refresh_token: cfg.GOOGLE_REFRESH_TOKEN });
  const drive = google.drive({ version: 'v3', auth });
  const name = process.argv[2] ?? 'College Expenses Receipts';
  const res = await drive.files.create({ requestBody: { name, mimeType: 'application/vnd.google-apps.folder' }, fields: 'id,name' });
  console.log(`\n✓ Created Drive folder "${res.data.name}"\n`);
  console.log(`DRIVE_FOLDER_ID=${res.data.id}\n`);
  console.log('Add that line to your .env.');
}

main().catch((e: Error) => fail(`Could not create folder: ${e.message}`));
