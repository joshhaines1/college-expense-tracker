import fs from 'node:fs';
import path from 'node:path';
import { Mutex } from '../lib/mutex';

export interface SubmissionRecord {
  key: string;
  /** uploaded: file in Drive, not yet shared. shared: link-viewable verified. done: row written to the sheet. */
  status: 'uploaded' | 'shared' | 'done';
  fileId: string;
  row?: number;
  date?: string;
  amount?: number;
  createdAt: number;
  updatedAt: number;
}

export interface SubmissionStore {
  get(key: string): SubmissionRecord | undefined;
  put(rec: SubmissionRecord): Promise<void>;
}

const RETENTION_MS = 60 * 24 * 3600 * 1000;

/** Lightweight JSON-file state (idempotency keys → Drive file / sheet row). Contains no receipt content or secrets. */
export class FileSubmissionStore implements SubmissionStore {
  private readonly file: string;
  private readonly records = new Map<string, SubmissionRecord>();
  private readonly lock = new Mutex();

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.file = path.join(dataDir, 'submissions.json');
    if (fs.existsSync(this.file)) {
      try {
        const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8')) as SubmissionRecord[];
        for (const r of parsed) this.records.set(r.key, r);
      } catch {
        // Corrupt state must not block the app; sheet-level duplicate detection (by Drive file id) still protects retries.
        fs.renameSync(this.file, `${this.file}.corrupt-${Date.now()}`);
      }
    }
  }

  get(key: string): SubmissionRecord | undefined {
    return this.records.get(key);
  }

  put(rec: SubmissionRecord): Promise<void> {
    return this.lock.run(async () => {
      this.records.set(rec.key, rec);
      const cutoff = Date.now() - RETENTION_MS;
      for (const [k, r] of this.records) if (r.status === 'done' && r.updatedAt < cutoff) this.records.delete(k);
      const tmp = `${this.file}.tmp`;
      await fs.promises.writeFile(tmp, JSON.stringify([...this.records.values()]), { mode: 0o600 });
      await fs.promises.rename(tmp, this.file);
    });
  }
}
