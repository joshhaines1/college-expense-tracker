import { z } from 'zod';
import { AppError } from '../lib/errors';
import { log } from '../lib/logger';
import { receiptUrl, type ReceiptStorage } from './drive';
import type { ValidatedImage } from './image';
import type { ExpenseSheet } from './sheets';
import type { SubmissionStore } from './submissionStore';

const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const clean = (max: number) =>
  z.string().max(max * 2).transform((s) => s.replace(CONTROL_CHARS, '').replace(/\r\n?/g, '\n').trim().slice(0, max));

export const expenseInputSchema = z.object({
  idempotencyKey: z.string().regex(/^[A-Za-z0-9_-]{16,64}$/, 'Invalid idempotency key'),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be YYYY-MM-DD')
    .refine((d) => {
      const dt = new Date(`${d}T00:00:00Z`);
      return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === d && dt.getUTCFullYear() >= 2000 && dt.getTime() <= Date.now() + 2 * 86_400_000;
    }, 'Date is not a valid past or present date'),
  amount: z
    .string()
    .regex(/^\d{1,6}(\.\d{1,2})?$/, 'Amount must be a positive number with at most 2 decimals')
    .transform(Number)
    .refine((n) => n > 0 && n < 100_000, 'Amount must be greater than 0'),
  description: clean(200).default(''),
  notes: clean(500).default(''),
});
export type ExpenseInput = z.infer<typeof expenseInputSchema>;

export interface SaveResult {
  amount: number;
  date: string;
  row: number;
  receiptUrl: string;
  duplicate: boolean;
}

export class ExpenseService {
  private readonly inflight = new Map<string, Promise<SaveResult>>();

  constructor(
    private readonly storage: ReceiptStorage,
    private readonly sheet: ExpenseSheet,
    private readonly store: SubmissionStore,
  ) {}

  /** Concurrent calls with the same idempotency key (double tap) share one execution. */
  save(input: ExpenseInput, image: Buffer, info: ValidatedImage): Promise<SaveResult> {
    const running = this.inflight.get(input.idempotencyKey);
    if (running) return running;
    const p = this.run(input, image, info).finally(() => this.inflight.delete(input.idempotencyKey));
    this.inflight.set(input.idempotencyKey, p);
    return p;
  }

  private async run(input: ExpenseInput, image: Buffer, info: ValidatedImage): Promise<SaveResult> {
    const key = input.idempotencyKey;
    let rec = this.store.get(key);

    if (rec?.status === 'done') {
      return { amount: rec.amount ?? input.amount, date: rec.date ?? input.date, row: rec.row ?? 0, receiptUrl: receiptUrl(rec.fileId), duplicate: true };
    }

    // 1. Upload once. A retry after a later failure reuses the stored file instead of uploading again.
    if (!rec) {
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '');
      const fileId = await this.storage.upload({ name: `receipt_${input.date}_${stamp}_${key.slice(0, 8)}.${info.ext}`, mime: info.mime, data: image });
      rec = { key, status: 'uploaded', fileId, createdAt: Date.now(), updatedAt: Date.now() };
      await this.store.put(rec);
      log.info('receipt uploaded', { fileId });
    }

    // 2. Make link-viewable and verify. Failure stops here: no sheet row, no misleading URL.
    if (rec.status === 'uploaded') {
      await this.storage.makeLinkViewable(rec.fileId);
      rec = { ...rec, status: 'shared', updatedAt: Date.now() };
      await this.store.put(rec);
    }

    // 3. Write the row (the sheet layer also refuses to duplicate a row that references this Drive file).
    const { row, alreadyPresent } = await this.sheet.appendExpense({
      date: input.date,
      description: input.description,
      category: 'Groceries',
      amount: input.amount,
      receiptFileId: rec.fileId,
      notes: input.notes,
    });
    await this.store.put({ ...rec, status: 'done', row, date: input.date, amount: input.amount, updatedAt: Date.now() });
    log.info('expense saved', { row, duplicate: alreadyPresent });
    return { amount: input.amount, date: input.date, row, receiptUrl: receiptUrl(rec.fileId), duplicate: alreadyPresent };
  }
}

export function toAppError(err: unknown): AppError {
  return err instanceof AppError ? err : new AppError(500, 'internal', 'Something went wrong on the server.');
}
