const HEIC_RE = /\.(heic|heif)$/i;

export function isHeic(file: File): boolean {
  return /image\/hei[cf]/i.test(file.type) || HEIC_RE.test(file.name);
}

/** File types the pickers advertise. Deliberately excludes HEIC: see the note on `prepareImage`. */
export const ACCEPT = 'image/jpeg,image/png,image/webp';

/**
 * iOS Safari transparently converts HEIC photos to JPEG when a file input's `accept` lists only JPEG/PNG/WebP
 * (listing image/heic would turn that conversion off). If a HEIC file still arrives (e.g. from the Files app), we
 * fail early with a clear fallback instead of bundling a large in-browser decoder.
 */
export async function prepareImage(file: File): Promise<File> {
  if (isHeic(file)) {
    throw new Error('That photo is in HEIC format, which can\'t be read here. Take it again with "Take photo", or set Settings → Camera → Formats → "Most Compatible".');
  }
  if (!/^image\/(jpeg|png|webp)$/i.test(file.type)) {
    throw new Error('Unsupported file type. Please choose a JPEG, PNG or WebP photo.');
  }
  return file;
}
