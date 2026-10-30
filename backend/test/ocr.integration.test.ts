import { afterAll, describe, expect, it } from 'vitest';
import { OcrService } from '../src/services/ocr';
import { renderReceipt } from './helpers';

const ocr = new OcrService(60_000);
afterAll(() => ocr.close());

describe('OCR pipeline (real Tesseract)', () => {
  it('reads date and total from a rendered receipt', async () => {
    const d = new Date();
    d.setDate(d.getDate() - 2);
    const us = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
    const img = await renderReceipt(['FRESH MARKET', us + ' 14:03', 'MILK 1GAL     3.48', 'BREAD         2.50', 'SUBTOTAL      5.98', 'TAX           0.39', 'TOTAL         6.37', 'VISA TEND     6.37']);
    const r = await ocr.scan(img);
    expect(r.total).toBe(6.37);
    expect(r.date).toBe(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }, 90_000);
});
