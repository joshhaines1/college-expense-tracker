# College Expense Tracker

A private, self-hosted, mobile-first app: photograph a grocery receipt on your iPhone, review the OCR'd
date and total, and save it as a new row in your existing Google Sheet (tab `Sheet1`) with the original
photo stored in Google Drive and a clickable **Receipt Link**.

- **Frontend:** React + TypeScript + Vite, served by unprivileged Nginx.
- **Backend:** Node 20 + Express + TypeScript. OCR runs **locally** with Tesseract.js (no paid API; the
  English model ships inside the Docker image, so OCR needs no internet).
- **Storage:** Google Sheets is the source of truth. No database. A tiny JSON file in a Docker volume only
  remembers idempotency keys (Drive file ID / sheet row) so retries never duplicate.
- **Network:** everything runs on your Linux ThinkPad. Nginx listens on `127.0.0.1:8080` only; Express has no
  published port. **Tailscale Serve** exposes it to your tailnet over HTTPS. No Funnel, no port forwarding.

```
iPhone (Tailscale) ──HTTPS──► Tailscale Serve ──► 127.0.0.1:8080 Nginx ──► /        static React app
                                                                      └──► /api/*   Express (docker network only)
                                                                                      ├─ Tesseract.js OCR
                                                                                      ├─ Google Drive (upload + link-share)
                                                                                      └─ Google Sheets (write row)
```

## What happens when you save

1. The photo is uploaded to the backend, validated by content (magic bytes + a real decode), and OCR'd.
   Suggested **date** and **total** appear in editable fields. Uncertain/missing values are highlighted.
   Nothing is saved until you tap **Save**.
2. On Save the backend (a) uploads the original image to your Drive receipts folder, (b) sets
   *anyone with the link → Viewer* and **verifies** it, then (c) writes columns **B–G** of the first unused
   transaction row in one atomic `batchUpdate`, then (d) reads the row back to verify types.
3. If sharing fails, **no row is written** and no misleading URL is produced. If the sheet write fails after
   the upload, the Drive file is kept and the next retry **reuses it** (it never uploads again, and never
   writes a second row; the sheet is checked for the file's ID before every write).

Row written (existing columns, header row 7, data from row 8; column A and the dashboard are never touched):

| Col | Value |
|---|---|
| B | receipt date (a real date serial; existing cell format kept, `yyyy-mm-dd` applied only if the cell has none) |
| C | description (blank by default) |
| D | `Groceries` |
| E | amount (a real number; currency format applied only if the cell isn't already currency/2-decimal) |
| F | `=HYPERLINK("https://drive.google.com/file/d/<FILE_ID>/view", "Receipt Link")` |
| G | notes |

Description and notes are written as **typed string values** (never `USER_ENTERED` parsing), so text like
`=HYPERLINK(...)` stays literal text. The only formula written is the link, built from a Drive file ID that is
validated against `[A-Za-z0-9_-]+`.

---

## 1. Repository layout

```
backend/            Express + OCR + Google integrations (TypeScript), tests, setup scripts
frontend/           React + Vite + TypeScript
nginx/default.conf  static assets + /api reverse proxy
docker-compose.yml  web (127.0.0.1:8080) + backend (internal only)
.env.example        every setting, no secrets
```

## 2. Prerequisites

- Mac (development) and the Linux ThinkPad with **Docker Engine + Docker Compose v2**.
- **Tailscale** on the ThinkPad and iPhone, same tailnet. In the Tailscale admin console enable **MagicDNS** and
  **HTTPS Certificates** (DNS page).
- Node 20+ on the Mac (for `npm run auth` and local dev).
- A Google account that owns the spreadsheet.

## 3. Google Cloud setup (one time)

Do this on your Mac, in a browser signed into the Google account that owns the sheet.

1. **Create a project** at <https://console.cloud.google.com/> (e.g. "College Expenses").
2. **Enable APIs** (APIs & Services → Library): **Google Sheets API** and **Google Drive API**.
3. **OAuth consent screen** (APIs & Services → OAuth consent screen / Google Auth Platform):
   - User type **External**; app name e.g. "College Expense Tracker"; your email as support/developer contact.
   - Add scopes: `.../auth/spreadsheets` and `.../auth/drive.file`.
   - Branding: Google requires an **app homepage URL** and a **privacy policy URL** to publish an External app
     (terms of use and logo are optional; skip the logo). Any public URL works, e.g. the repo page and a link to
     the *Privacy policy* section (13) below. Google does not review these for unverified personal apps.
   - **Publish the app (Publishing status → "In production").** This matters: apps left in **Testing** get
     refresh tokens that **expire after 7 days** for non-basic scopes, and the app would silently stop working
     every week. In production, tokens don't have that 7-day expiry.
   - You do **not** need Google verification for personal use: unverified production apps work for up to 100
     users and just show an "unverified app" warning once during consent (Advanced → "Go to … (unsafe)"; it's
     your own app). If you ever see `invalid_grant` later, see *Re-authorizing* below.
4. **Create credentials** → *OAuth client ID* → application type **Desktop app**. Copy the client ID and secret.
5. **Get your spreadsheet ID**: open the sheet; the ID is the long part of
   `https://docs.google.com/spreadsheets/d/<SPREADSHEET_ID>/edit`.

**Why these scopes?** `spreadsheets` is the narrowest scope that lets the REST API edit a spreadsheet that
already exists. For Drive the app uses `drive.file`, which only lets it see files/folders **it created**. That's
least privilege, but it means the receipts folder must be created by the app (step 5 below), not by hand.

## 4. Configure and authorize (on the Mac)

```bash
cp .env.example .env && chmod 600 .env
# edit .env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, SPREADSHEET_ID  (leave the rest for now)

cd backend && npm install
npm run auth
```

`npm run auth` opens a browser consent page and receives the redirect on `http://127.0.0.1:53682` (PKCE + state
checked). It prints one line to **your terminal**:

```
GOOGLE_REFRESH_TOKEN=1//0g...
```

Paste it into `.env`. Never paste it into chat, source code, or Git.

Create the Drive folder (stays private; only individual receipt files are link-shared):

```bash
npm run setup:folder -- "College Expenses Receipts"   # prints DRIVE_FOLDER_ID=...; add it to .env
```

Then run the **read-only** configuration check:

```bash
npm run check-sheet
```

It confirms the tab exists, the header row (B7:G7) matches *Date | Description | Category | Amount | Receipt
Link | Notes*, shows the first unused row, lists your dashboard formulas, and **warns if any summary formula
uses a bounded range** (e.g. `E8:E200`) that new rows would eventually fall outside. If it does, widen the range
in the sheet (e.g. `E8:E`). It writes nothing.

> Optional: set `ALLOWED_TAILSCALE_LOGIN=you@example.com` in `.env` to make the API reject any tailnet user other
> than you (see *Access control*).

## 5. Run locally on the Mac (development)

```bash
# terminal 1
cd backend && npm run dev            # http://127.0.0.1:3001, reads ../.env
# terminal 2
cd frontend && npm install && npm run dev   # http://127.0.0.1:5173, proxies /api to the backend
```

Tests and type checks:

```bash
cd backend  && npm test && npm run typecheck     # parser, sheet-row selection, sheets writer, save flow, API, real OCR
cd frontend && npm test && npm run build
```

Phone camera access requires HTTPS, so to test on the iPhone during development just deploy (below), or run
`tailscale serve --bg 5173` on the Mac.

## 6. Deploy on the Linux ThinkPad

**First time**

```bash
git clone <your-repo-url> ~/college-expenses && cd ~/college-expenses
cp .env.example .env && chmod 600 .env   # then fill it in (see below)
docker compose up -d --build
docker compose ps                         # both services running; backend "healthy"
curl -s http://127.0.0.1:8080/api/health  # {"status":"ok"}
```

Fill `.env` on the server by copying the values from the Mac **over SSH/scp or a password manager**
(`scp .env user@thinkpad:~/college-expenses/.env`, then `chmod 600`). `.env` is git-ignored; secrets are never in
the images or the frontend bundle.

**Publish privately over Tailscale (HTTPS)**

```bash
sudo tailscale serve --bg 8080
tailscale serve status        # shows https://<thinkpad>.<tailnet>.ts.net  →  http://127.0.0.1:8080
```

Do **not** run `tailscale funnel`, and do not open or forward any router port. Verify `tailscale funnel status`
shows nothing, and that `ss -tlnp | grep 8080` shows `127.0.0.1:8080` (not `0.0.0.0`).

On the iPhone: Tailscale on → Safari → `https://<thinkpad>.<tailnet>.ts.net` → Share → **Add to Home Screen**.

**Survive reboots**

```bash
sudo systemctl enable --now docker tailscaled
```

Containers use `restart: unless-stopped`, and `tailscale serve --bg` is persisted by `tailscaled`. Test it:
`sudo reboot`, then reopen the app from your phone on **cellular** (Wi‑Fi off).

**Update from the Mac**

```bash
# Mac
git add -A && git commit -m "…" && git push
# ThinkPad
cd ~/college-expenses && git pull && docker compose up -d --build
```

## 7. Access control

Tailscale gives network admission, not per-request identity, so use layers:

1. **Tailnet ACL/grants** — only your user/devices may reach the ThinkPad on port 443. If your tailnet is only
   you, the default already does this; if you share it, restrict explicitly (admin console → Access controls):
   ```json
   {"grants": [{"src": ["you@example.com"], "dst": ["tag:expenses-server"], "ip": ["tcp:443"]}]}
   ```
   (tag the ThinkPad `tag:expenses-server`, or use its user/hostname per your policy).
2. **`ALLOWED_TAILSCALE_LOGIN`** in `.env` — Tailscale Serve adds `Tailscale-User-Login` to proxied requests; when
   this variable is set the API returns 403 for any other login (including requests with no header). Nginx
   forwards that header. Because only Tailscale Serve (and local processes on the ThinkPad) can reach
   `127.0.0.1:8080`, this is a meaningful identity check, but anyone with a shell on the ThinkPad could spoof it,
   so keep the machine itself trusted.
3. **CSRF** — every non-GET request must carry `X-Requested-With: college-expenses` (the app sets it). A
   cross-site page can't send a custom header without a CORS preflight, and the API serves no CORS. The app is
   same-origin end to end.
4. Other hardening in place: server-side upload size limit, content sniffing + full image decode (extension and
   declared MIME are ignored), pixel-count cap, rate limits, input validation (zod), bounded OCR runtime
   (timeout resets the worker), Helmet and a strict CSP, non-root read-only containers with all capabilities
   dropped, no receipt text/tokens in logs, receipts held in memory only (no temp files to clean up).

## 8. Receipt links are public-by-link (by design)

Per your requirement, each receipt file is shared as **Anyone with the link → Viewer**. Anyone who obtains a
receipt URL (e.g. if the sheet is shared, or a link is forwarded) can view that image. The **spreadsheet and the
folder are never made public** by this app. If your account or Workspace policy blocks link sharing, saving fails
with a clear message and no row is written (the uploaded file stays private in the folder).

## 9. Operations

**Logs / status**

```bash
docker compose ps
docker compose logs -f backend      # structured JSON, no receipt contents or tokens
docker compose logs -f web
tailscale serve status
```

**Re-run the configuration check on the server**

```bash
docker compose run --rm backend node dist/scripts/check-sheet.js
```

**Re-authorizing** (`google_auth_expired` / `invalid_grant`: token revoked, app was in Testing, password reset
with revocation, or 6 months unused): on the Mac run `npm run auth` again, replace `GOOGLE_REFRESH_TOKEN` in the
server's `.env`, then `docker compose up -d` (recreates the backend with the new env).

**Backup & recovery**

- The Sheet and Drive are the source of truth; Google keeps their history (Sheet → File → Version history).
- Back up **`.env`** (password manager). Losing it is recoverable: create a new OAuth client/token with steps 3–4
  (note a new `drive.file` token can't see the old folder — run `setup:folder` again and update `DRIVE_FOLDER_ID`;
  existing receipt links keep working).
- The `receipt_state` volume only holds idempotency state. Optional backup:
  `docker volume ls | grep receipt_state` to find the exact name, then
  `docker run --rm -v <that_name>:/d -v "$PWD":/b alpine tar czf /b/state.tgz -C /d .`
  If it's lost, retry protection still works via the sheet-level file-ID check; you only lose the "already saved"
  shortcut.
- Orphans: if sharing fails and you never retry, a private receipt file remains in the Drive folder; delete it
  manually if you like.

## 10. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| App won't load on iPhone | Tailscale off on the phone; `tailscale serve status` on the server; HTTPS certs not enabled for the tailnet. |
| "Can't reach the server" in the app | Server down or Tailscale disconnected. `docker compose ps`, `curl http://127.0.0.1:8080/api/health` on the ThinkPad. |
| 403 "not allowed to use this app" | `ALLOWED_TAILSCALE_LOGIN` doesn't match your Tailscale login (or you're hitting a non-Serve URL). Check `tailscale status` for the login. |
| Save says Google isn't configured | Missing variables in `.env` (the message names them). `docker compose up -d` after editing. |
| `google_auth_expired` | See *Re-authorizing*. If it recurs weekly, the consent screen is still in **Testing** — publish it. |
| `google_not_found` on save | `SPREADSHEET_ID` wrong, or `DRIVE_FOLDER_ID` isn't a folder created by `npm run setup:folder` (drive.file can't use other folders). |
| `share_forbidden` | Account/Workspace policy forbids link sharing. Allow it or use a personal Google account. |
| `google_quota` | Wait a minute and retry; nothing is duplicated. |
| Totals missing or wrong | Flat, well-lit, whole receipt in frame, portrait. You can always type the values; "Show text read from receipt" reveals what OCR saw. |
| HEIC message | Use **Take photo**, or Settings → Camera → Formats → **Most Compatible**. (Safari converts to JPEG automatically for these pickers.) |
| Dashboard doesn't include new rows | Run `npm run check-sheet`; widen any bounded range it reports. |
| Port 8080 already in use | Change the host port in `docker-compose.yml` (keep `127.0.0.1:`) and `tailscale serve --bg <port>`. |

## 11. Test scenarios (do these before relying on it)

1. **Mac:** `npm test` in `backend/` and `frontend/` pass; `npm run check-sheet` is clean.
2. **Sample row:** save a test receipt from the app. Confirm in Sheet1: new row at the first free row; B is a date,
   E is a number, D is `Groceries` with its dropdown intact, F opens the receipt in Drive (try it in a private
   window to confirm link-sharing); dashboard totals changed by the amount. Delete the test row afterwards (and
   the test file in Drive).
3. **Formula safety:** description `=1+1` and notes `@SUM(1)` appear as literal text.
4. **Duplicate protection:** double-tap Save; enable airplane mode right after tapping, then retry. One row only.
5. **Failure paths:** stop the backend (`docker compose stop backend`) → friendly "can't reach/not responding";
   remove a variable → "not configured"; break the refresh token → re-auth message.
6. **Real receipts:** try several stores/layouts, crumpled, dark, tilted. Expect some to need manual correction.
7. **Network:** use cellular with Wi‑Fi off; reboot the ThinkPad and confirm the app returns on its own;
   confirm `https://…ts.net` is unreachable from a device **not** on your tailnet.

## 12. Known limits & not-yet-built

- OCR is imperfect by nature. The app reports `ok / uncertain / missing` per field plus warnings (multiple
  totals, total below subtotal, refund/void text, card-line fallback, old/ambiguous dates) rather than a fake
  confidence number. Dates are read as US `MM/DD/YY`.
- Row insertion: if the table runs to the very bottom of the grid, the backend appends a row and copies
  **formatting and data validation only** from the row above. Pre-formatted blank rows are used first.
- The sheet's formulas are never modified; only `check-sheet` inspects them.
- Phase two (not built): recent-expense history / `GET /api/expenses`, spending summaries, duplicate-warning UI
  based on date+amount, non-grocery categories, offline queue.
- Single instance by design: the in-process lock that serialises sheet writes assumes one backend container.

## 13. Privacy policy

*Last updated: 2026-10-30.* College Expense Tracker is a personal, self-hosted app run by its owner for their own
use. This section is the app's privacy policy and is the page to link from the Google OAuth consent screen.

- **What it accesses:** only the owner's own Google Sheet (to read the table and append expense rows) and a single
  Google Drive folder the app creates (`drive.file` scope, so it can't see any other Drive file).
- **What it stores:** receipt photos in that Drive folder, and expense rows in that Sheet. Both stay in the
  owner's Google account. The OAuth refresh token and client secret live only in the owner's `.env` on their own
  machines.
- **Sharing:** no data is sold, shared with third parties, or used for advertising. No analytics or tracking.
  Receipt files are viewable by anyone with their link (see section 8); the Sheet and folder are not made public.
- **Retention and deletion:** data stays until the owner deletes it from Google Drive/Sheets. Access can be revoked
  any time at <https://myaccount.google.com/permissions>.
- **Contact:** the developer contact email on the OAuth consent screen.
