import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../src/lib/errors';
import { ExpenseService, expenseInputSchema } from '../src/services/expenseService';
import { FileSubmissionStore } from '../src/services/submissionStore';

const FILE_ID = '1AbCdEfGhIjKlMnOpQrStUv';
const info = { kind: 'jpeg' as const, mime: 'image/jpeg', ext: 'jpg' };
const input = (over: Record<string, unknown> = {}) =>
  expenseInputSchema.parse({ idempotencyKey: 'abcdefghijklmnop1234', date: '2026-10-28', amount: '47.82', description: '', notes: '', ...over });

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-'));
  const storage = { upload: vi.fn(async () => FILE_ID), makeLinkViewable: vi.fn(async () => undefined) };
  const sheet = { appendExpense: vi.fn(async () => ({ row: 9, alreadyPresent: false })) };
  const store = new FileSubmissionStore(dir);
  return { storage, sheet, store, svc: new ExpenseService(storage, sheet, store), dir };
}

describe('input validation', () => {
  it('normalises text and rejects bad values', () => {
    expect(input({ notes: '  hi\u0000 there ' }).notes).toBe('hi there');
    expect(() => input({ amount: '-3' })).toThrow();
    expect(() => input({ amount: '0' })).toThrow();
    expect(() => input({ amount: '1.234' })).toThrow();
    expect(() => input({ date: '2026-02-31' })).toThrow();
    expect(() => input({ date: '2099-01-01' })).toThrow();
    expect(() => input({ idempotencyKey: 'short' })).toThrow();
  });
  it('keeps formula-like text as plain strings (neutralised later by typed cell writes)', () => {
    expect(input({ description: '=HYPERLINK("http://evil")' }).description).toBe('=HYPERLINK("http://evil")');
  });
});

describe('ExpenseService', () => {
  it('uploads, shares, writes, and returns the receipt link', async () => {
    const { svc, storage, sheet } = setup();
    const r = await svc.save(input(), Buffer.from('x'), info);
    expect(r).toMatchObject({ amount: 47.82, row: 9, duplicate: false, receiptUrl: `https://drive.google.com/file/d/${FILE_ID}/view` });
    expect(storage.upload).toHaveBeenCalledOnce();
    expect(sheet.appendExpense.mock.calls[0]![0]).toMatchObject({ category: 'Groceries', receiptFileId: FILE_ID });
  });

  it('does not write to the sheet when sharing fails, and does not re-upload on retry', async () => {
    const { svc, storage, sheet } = setup();
    storage.makeLinkViewable.mockRejectedValueOnce(new AppError(502, 'share_forbidden', 'nope'));
    await expect(svc.save(input(), Buffer.from('x'), info)).rejects.toMatchObject({ code: 'share_forbidden' });
    expect(sheet.appendExpense).not.toHaveBeenCalled();

    await svc.save(input(), Buffer.from('x'), info);
    expect(storage.upload).toHaveBeenCalledOnce();
    expect(sheet.appendExpense).toHaveBeenCalledOnce();
  });

  it('does not re-upload or re-share when only the sheet write failed', async () => {
    const { svc, storage, sheet } = setup();
    sheet.appendExpense.mockRejectedValueOnce(new AppError(503, 'google_quota', 'slow down', true));
    await expect(svc.save(input(), Buffer.from('x'), info)).rejects.toMatchObject({ retryable: true });
    await svc.save(input(), Buffer.from('x'), info);
    expect(storage.upload).toHaveBeenCalledOnce();
    expect(storage.makeLinkViewable).toHaveBeenCalledOnce();
  });

  it('returns the stored result for a repeated key and writes only once', async () => {
    const { svc, sheet } = setup();
    await svc.save(input(), Buffer.from('x'), info);
    const again = await svc.save(input(), Buffer.from('x'), info);
    expect(again.duplicate).toBe(true);
    expect(sheet.appendExpense).toHaveBeenCalledOnce();
  });

  it('collapses concurrent double taps into one execution', async () => {
    const { svc, storage, sheet } = setup();
    const [a, b] = await Promise.all([svc.save(input(), Buffer.from('x'), info), svc.save(input(), Buffer.from('x'), info)]);
    expect(a).toEqual(b);
    expect(storage.upload).toHaveBeenCalledOnce();
    expect(sheet.appendExpense).toHaveBeenCalledOnce();
  });

  it('survives a restart (state persisted to disk)', async () => {
    const { svc, dir, storage } = setup();
    await svc.save(input(), Buffer.from('x'), info);
    const svc2 = new ExpenseService(storage, { appendExpense: vi.fn() }, new FileSubmissionStore(dir));
    expect((await svc2.save(input(), Buffer.from('x'), info)).duplicate).toBe(true);
  });
});
