import sharp from 'sharp';
import { AppError } from '../lib/errors';

export type ImageKind = 'jpeg' | 'png' | 'webp';

export interface ValidatedImage {
  kind: ImageKind;
  mime: string;
  ext: string;
}

const KINDS: Record<ImageKind, { mime: string; ext: string }> = {
  jpeg: { mime: 'image/jpeg', ext: 'jpg' },
  png: { mime: 'image/png', ext: 'png' },
  webp: { mime: 'image/webp', ext: 'webp' },
};

/** Identify the format from magic bytes only — the client-declared MIME type and filename are never trusted. */
export function sniffImage(buf: Buffer): ImageKind | 'heic' | null {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  if (buf.toString('ascii', 4, 8) === 'ftyp' && /^(heic|heix|hevc|hevx|mif1|msf1|heim|heis)/.test(buf.toString('ascii', 8, 12))) return 'heic';
  return null;
}

const MAX_PIXELS = 60_000_000;

/** Verify the bytes are a real, decodable JPEG/PNG/WebP of sane dimensions. */
export async function validateImage(buf: Buffer): Promise<ValidatedImage> {
  const kind = sniffImage(buf);
  if (kind === 'heic') {
    throw new AppError(415, 'heic_unsupported', 'HEIC/HEIF photos could not be converted on your device. Choose a JPEG or PNG, or set the iPhone camera to "Most Compatible".');
  }
  if (!kind) {
    throw new AppError(415, 'unsupported_image', 'Unsupported file. Please upload a JPEG, PNG or WebP photo of the receipt.');
  }
  try {
    const meta = await sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata();
    if (!meta.width || !meta.height || meta.width < 100 || meta.height < 100) {
      throw new AppError(422, 'image_too_small', 'The image is too small to read. Take a closer, larger photo of the receipt.');
    }
    // Force a full decode of a tiny version to catch truncated/corrupt files.
    await sharp(buf, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).resize(32, 32, { fit: 'inside' }).raw().toBuffer();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(422, 'invalid_image', 'That image could not be read (it may be corrupt or too large). Try taking the photo again.');
  }
  return { kind, ...KINDS[kind] };
}

/** Normalise orientation/size/contrast for OCR. `binarize` is a harsher second-pass variant. */
export async function preprocessForOcr(buf: Buffer, binarize = false): Promise<Buffer> {
  let img = sharp(buf, { limitInputPixels: MAX_PIXELS }).rotate().resize({ width: 1800, height: 6000, fit: 'inside', withoutEnlargement: false }).grayscale().normalize();
  img = binarize ? img.sharpen().threshold(150) : img.sharpen();
  return img.png().toBuffer();
}
