import { Readable } from 'node:stream';
import { AppError, mapGoogleError } from '../lib/errors';
import type { GoogleClients } from './google';

export interface ReceiptStorage {
  /** Uploads the original image into the receipts folder and returns the new file's id. */
  upload(file: { name: string; mime: string; data: Buffer }): Promise<string>;
  /** Grants "anyone with the link can view" and verifies the permission is really in place. Throws if not. */
  makeLinkViewable(fileId: string): Promise<void>;
}

export const FILE_ID_RE = /^[A-Za-z0-9_-]{10,200}$/;

export function receiptUrl(fileId: string): string {
  if (!FILE_ID_RE.test(fileId)) throw new Error('Unexpected Drive file id');
  return `https://drive.google.com/file/d/${fileId}/view`;
}

export class GoogleDriveStorage implements ReceiptStorage {
  constructor(
    private readonly drive: GoogleClients['drive'],
    private readonly folderId: string,
  ) {}

  async upload(file: { name: string; mime: string; data: Buffer }): Promise<string> {
    try {
      const res = await this.drive.files.create({
        requestBody: { name: file.name, parents: [this.folderId], mimeType: file.mime },
        media: { mimeType: file.mime, body: Readable.from(file.data) },
        fields: 'id',
        supportsAllDrives: false,
      });
      const id = res.data.id;
      if (!id || !FILE_ID_RE.test(id)) throw new AppError(502, 'drive_bad_response', 'Google Drive returned an unexpected response while uploading the receipt.', true);
      return id;
    } catch (err) {
      throw mapGoogleError(err, 'upload the receipt to Google Drive');
    }
  }

  async makeLinkViewable(fileId: string): Promise<void> {
    try {
      await this.drive.permissions.create({
        fileId,
        requestBody: { type: 'anyone', role: 'reader', allowFileDiscovery: false },
        fields: 'id',
      });
      const list = await this.drive.permissions.list({ fileId, fields: 'permissions(id,type,role)' });
      const anyone = (list.data.permissions ?? []).filter((p) => p.type === 'anyone');
      if (!anyone.some((p) => p.role === 'reader') || anyone.some((p) => p.role !== 'reader')) {
        throw new AppError(502, 'share_unverified', 'The receipt was uploaded, but Google did not confirm "anyone with the link can view". Nothing was written to the sheet. Tap Save to retry.', true);
      }
    } catch (err) {
      if (err instanceof AppError) throw err;
      const mapped = mapGoogleError(err, 'share the receipt');
      if (mapped.code === 'google_forbidden') {
        throw new AppError(
          502,
          'share_forbidden',
          'Google refused to make the receipt link-viewable (your account or Workspace policy may block public link sharing). The receipt was uploaded privately and nothing was written to the sheet.',
        );
      }
      throw mapped;
    }
  }
}
