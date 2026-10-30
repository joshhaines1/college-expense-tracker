import fs from 'node:fs';
import path from 'node:path';
import { createWorker, PSM, type Worker } from 'tesseract.js';
import { AppError } from '../lib/errors';
import { log } from '../lib/logger';
import { Mutex } from '../lib/mutex';
import { preprocessForOcr } from './image';
import { parseReceipt, type ParsedReceipt } from './receiptParser';

/** Language data is bundled with the @tesseract.js-data/eng package, so OCR never needs internet access. */
function resolveLangPath(): string {
  const pkgDir = path.dirname(require.resolve('@tesseract.js-data/eng/package.json'));
  const best = path.join(pkgDir, '4.0.0_best_int');
  return fs.existsSync(best) ? best : path.join(pkgDir, '4.0.0');
}

export interface ScanResult extends ParsedReceipt {
  rawText: string;
}

export class OcrService {
  private worker: Worker | null = null;
  private readonly queue = new Mutex();

  constructor(private readonly timeoutMs: number) {}

  private async getWorker(): Promise<Worker> {
    if (this.worker) return this.worker;
    const worker = await createWorker('eng', 1, {
      langPath: resolveLangPath(),
      gzip: true,
      cacheMethod: 'none', // never write language data to disk at runtime
      logger: () => undefined, // progress messages could otherwise leak into logs
    });
    await worker.setParameters({
      tessedit_pageseg_mode: PSM.SINGLE_COLUMN,
      preserve_interword_spaces: '1',
      user_defined_dpi: '300',
    });
    this.worker = worker;
    return worker;
  }

  private async resetWorker(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    if (w) await w.terminate().catch(() => undefined);
  }

  private async recognize(image: Buffer): Promise<string> {
    const worker = await this.getWorker();
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new AppError(504, 'ocr_timeout', 'Reading the receipt took too long. Try a clearer, closer photo.', true)), this.timeoutMs);
    });
    try {
      const { data } = await Promise.race([worker.recognize(image), timeout]);
      return data.text ?? '';
    } catch (err) {
      // A timed-out or crashed worker may still be busy: discard it so the next scan starts clean.
      await this.resetWorker();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Runs OCR (serialised — Tesseract is CPU heavy) and parses date/total. A second, binarized pass is tried if needed. */
  scan(original: Buffer): Promise<ScanResult> {
    return this.queue.run(async () => {
      try {
        let text = await this.recognize(await preprocessForOcr(original));
        let parsed = parseReceipt(text);
        if (parsed.total === null || parsed.date === null) {
          const text2 = await this.recognize(await preprocessForOcr(original, true));
          const parsed2 = parseReceipt(text2);
          const score = (p: ParsedReceipt) => Number(p.total !== null) + Number(p.date !== null);
          if (score(parsed2) > score(parsed)) {
            text = text2;
            parsed = parsed2;
          }
        }
        return { ...parsed, rawText: text };
      } catch (err) {
        if (err instanceof AppError) throw err;
        log.error('ocr failed', { error: err instanceof Error ? err.name : 'unknown' });
        throw new AppError(500, 'ocr_failed', 'The receipt could not be read. Try another photo, or enter the details manually.');
      }
    });
  }

  async close(): Promise<void> {
    await this.resetWorker();
  }
}
