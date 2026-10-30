import { google } from 'googleapis';
import type { GoogleConfig } from '../lib/config';

/**
 * Scopes (kept minimal):
 *  - spreadsheets: required to edit the *existing* sheet via the API. (Google has no narrower scope for a
 *    pre-existing spreadsheet that works with the REST API.)
 *  - drive.file: access only to files this app creates (and folders created by it). The receipts folder must
 *    therefore be created via `npm run setup:folder`, not by hand in the Drive UI.
 */
export const GOOGLE_SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive.file',
];

export function createOAuthClient(clientId: string, clientSecret: string, redirectUri?: string) {
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

export function createGoogleClients(cfg: GoogleConfig) {
  const auth = createOAuthClient(cfg.clientId, cfg.clientSecret);
  auth.setCredentials({ refresh_token: cfg.refreshToken });
  const options = { auth, timeout: 30_000 };
  return {
    sheets: google.sheets({ version: 'v4', ...options }),
    drive: google.drive({ version: 'v3', ...options }),
  };
}

export type GoogleClients = ReturnType<typeof createGoogleClients>;
