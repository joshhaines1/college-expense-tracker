import sharp from 'sharp';

/** Renders receipt-like text to a JPEG so the real OCR pipeline can be exercised without fixtures. */
export async function renderReceipt(lines: string[]): Promise<Buffer> {
  const h = 60 + lines.length * 44;
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const text = lines
    .map((l, i) => `<text x="30" y="${60 + i * 44}" font-family="Courier New, Courier, monospace" font-size="30" fill="#111">${esc(l)}</text>`)
    .join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="620" height="${h}"><rect width="100%" height="100%" fill="#fff"/>${text}</svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}
