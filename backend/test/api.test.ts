import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp, CSRF_HEADER, CSRF_VALUE } from '../src/app';
import { renderReceipt } from './helpers';

const scan = vi.fn(async () => ({ date: '2026-10-28', total: 6.37, dateStatus: 'ok' as const, totalStatus: 'ok' as const, warnings: [], rawText: 'x' }));
const save = vi.fn(async () => ({ amount: 6.37, date: '2026-10-28', row: 8, receiptUrl: 'https://drive.google.com/file/d/abc/view', duplicate: false }));

let server: Server;
let base: string;
let img: Buffer;

function app(over: Partial<Parameters<typeof createApp>[0]> = {}) {
  return createApp({ maxUploadBytes: 2 * 1024 * 1024, scanner: { scan }, expenses: { save }, ...over });
}
async function start(a: ReturnType<typeof app>) {
  await new Promise<void>((r) => {
    server = a.listen(0, '127.0.0.1', () => r());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}
const form = (file: Buffer | null, fields: Record<string, string> = {}) => {
  const f = new FormData();
  if (file) f.append('image', new Blob([new Uint8Array(file)], { type: 'image/jpeg' }), 'r.jpg');
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  return f;
};
const good = { idempotencyKey: 'abcdefghijklmnop1234', date: '2026-10-28', amount: '6.37', description: '', notes: '' };
const csrf = { [CSRF_HEADER]: CSRF_VALUE };

beforeAll(async () => {
  img = await renderReceipt(['TOTAL 6.37']);
  await start(app());
});
afterAll(() => server.close());

describe('API', () => {
  it('health is minimal', async () => {
    const r = await fetch(`${base}/health`);
    expect(await r.json()).toEqual({ status: 'ok' });
  });

  it('rejects POST without the CSRF header', async () => {
    const r = await fetch(`${base}/receipts/scan`, { method: 'POST', body: form(img) });
    expect(r.status).toBe(403);
  });

  it('scans a valid image', async () => {
    const r = await fetch(`${base}/receipts/scan`, { method: 'POST', headers: csrf, body: form(img) });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ total: 6.37, date: '2026-10-28' });
  });

  it('rejects non-images by content, whatever the declared type', async () => {
    const r = await fetch(`${base}/receipts/scan`, { method: 'POST', headers: csrf, body: form(Buffer.from('<?php echo 1; ?> not an image at all')) });
    expect(r.status).toBe(415);
    expect((await r.json()).error.code).toBe('unsupported_image');
  });

  it('explains HEIC fallback', async () => {
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypheic'), Buffer.alloc(32)]);
    const r = await fetch(`${base}/receipts/scan`, { method: 'POST', headers: csrf, body: form(heic) });
    expect((await r.json()).error.code).toBe('heic_unsupported');
  });

  it('rejects missing files and oversize files', async () => {
    expect((await fetch(`${base}/receipts/scan`, { method: 'POST', headers: csrf, body: form(null) })).status).toBe(400);
    const big = Buffer.alloc(3 * 1024 * 1024, 1);
    const r = await fetch(`${base}/receipts/scan`, { method: 'POST', headers: csrf, body: form(big) });
    expect(r.status).toBe(413);
  });

  it('saves a confirmed expense and validates fields', async () => {
    const ok = await fetch(`${base}/expenses`, { method: 'POST', headers: csrf, body: form(img, good) });
    expect(ok.status).toBe(201);
    expect(save).toHaveBeenCalledOnce();
    const bad = await fetch(`${base}/expenses`, { method: 'POST', headers: csrf, body: form(img, { ...good, amount: '-1' }) });
    expect(bad.status).toBe(400);
    expect(save).toHaveBeenCalledOnce();
  });

  it('unknown routes return JSON 404', async () => {
    const r = await fetch(`${base}/nope`);
    expect(r.status).toBe(404);
  });
});

describe('API access control', () => {
  it('enforces the Tailscale identity when configured', async () => {
    const s = app({ allowedTailscaleLogin: 'josh@example.com' }).listen(0, '127.0.0.1');
    await new Promise((r) => s.once('listening', r));
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api`;
    expect((await fetch(`${b}/health`)).status).toBe(200);
    expect((await fetch(`${b}/receipts/scan`, { method: 'POST', headers: csrf, body: form(img) })).status).toBe(403);
    expect((await fetch(`${b}/receipts/scan`, { method: 'POST', headers: { ...csrf, 'tailscale-user-login': 'other@example.com' }, body: form(img) })).status).toBe(403);
    expect((await fetch(`${b}/receipts/scan`, { method: 'POST', headers: { ...csrf, 'tailscale-user-login': 'Josh@Example.com' }, body: form(img) })).status).toBe(200);
    s.close();
  });

  it('reports missing Google config on save', async () => {
    const s = app({ expenses: null, missingGoogleConfig: ['SPREADSHEET_ID'] }).listen(0, '127.0.0.1');
    await new Promise((r) => s.once('listening', r));
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}/api`;
    const r = await fetch(`${b}/expenses`, { method: 'POST', headers: csrf, body: form(img, good) });
    expect(r.status).toBe(503);
    expect((await r.json()).error.message).toContain('SPREADSHEET_ID');
    s.close();
  });
});
