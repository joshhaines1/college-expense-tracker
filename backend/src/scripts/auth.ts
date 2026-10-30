/**
 * One-time interactive OAuth consent. Run on a trusted device with a browser (your Mac):
 *   npm run auth
 * The refresh token is printed to YOUR terminal only. Paste it into .env as GOOGLE_REFRESH_TOKEN.
 */
import { exec } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import { Auth } from 'googleapis';
import { GOOGLE_SCOPES, createOAuthClient } from '../services/google';
import { fail, loadScriptConfig } from './env';

const PORT = 53682;
const REDIRECT = `http://127.0.0.1:${PORT}/oauth2callback`;

async function main() {
  const cfg = loadScriptConfig();
  if (!cfg.GOOGLE_CLIENT_ID || !cfg.GOOGLE_CLIENT_SECRET) fail('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (see README step 3).');
  const client = createOAuthClient(cfg.GOOGLE_CLIENT_ID, cfg.GOOGLE_CLIENT_SECRET, REDIRECT);
  const state = crypto.randomBytes(16).toString('hex');
  const { codeVerifier, codeChallenge } = await client.generateCodeVerifierAsync();
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent', // forces a refresh token even if this client was authorised before
    scope: GOOGLE_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: Auth.CodeChallengeMethod.S256,
  });

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url ?? '/', REDIRECT);
      if (u.pathname !== '/oauth2callback') {
        res.writeHead(404).end();
        return;
      }
      const err = u.searchParams.get('error');
      const got = u.searchParams.get('code');
      if (err || !got || u.searchParams.get('state') !== state) {
        res.writeHead(400, { 'content-type': 'text/plain' }).end('Authorization failed. You can close this tab and check the terminal.');
        server.close();
        reject(new Error(err ?? 'invalid state or missing code'));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/plain' }).end('Authorization complete. You can close this tab and return to the terminal.');
      server.close();
      resolve(got);
    });
    server.on('error', reject);
    server.listen(PORT, '127.0.0.1', () => {
      console.log('\nOpen this URL in a browser signed into the Google account that owns the spreadsheet:\n');
      console.log(url, '\n');
      if (process.platform === 'darwin') exec(`open "${url}"`);
      else if (process.platform === 'linux') exec(`xdg-open "${url}"`);
    });
  });

  const { tokens } = await client.getToken({ code, codeVerifier });
  if (!tokens.refresh_token) {
    fail('Google did not return a refresh token. Remove this app at https://myaccount.google.com/permissions and run again.');
  }
  console.log('\n✓ Authorized. Add this line to your .env (keep it private, never commit it):\n');
  console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}\n`);
  console.log('Next: npm run setup:folder   (creates the Drive receipts folder and prints its ID)');
}

main().catch((e: Error) => fail(`Authorization failed: ${e.message}`));
