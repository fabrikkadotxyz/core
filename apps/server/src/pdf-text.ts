/**
 * The text layer of an uploaded PDF, page by page, for agents (M20).
 *
 * Parse, never execute (docs/security.md, Threat 7): pdf.js 6 has no eval-based
 * font compilation at all (the path behind CVE-2024-4367 was removed, and a unit
 * test fails if an upgrade brings it back); no fonts are loaded, nothing is
 * rendered, and only the text content is read. Bounded by size,
 * pages and characters, so a hostile file can waste one extraction and no more.
 */
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

export const MAX_PDF_BYTES = 25 * 1024 * 1024;
export const MAX_PAGES_PER_CALL = 50;
const MAX_CHARS_PER_CALL = 200_000;

export interface PdfText {
  totalPages: number;
  startPage: number;
  pages: { page: number; text: string }[];
  truncated: boolean;
  /** True when no page read had any text: a scan, or a PDF of images. */
  noTextLayer: boolean;
}

export function isPdf(contentType: string | null, content: Buffer): boolean {
  return contentType === 'application/pdf' || content.subarray(0, 5).toString('latin1') === '%PDF-';
}

export async function extractPdfText(
  content: Buffer,
  opts: { startPage?: number; maxPages?: number } = {},
): Promise<PdfText> {
  const task = getDocument({
    data: new Uint8Array(content),
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: false,
    verbosity: 0,
  });
  const doc = await task.promise;

  try {
    const totalPages = doc.numPages;
    const startPage = Math.min(Math.max(1, opts.startPage ?? 1), Math.max(1, totalPages));
    const maxPages = Math.min(Math.max(1, opts.maxPages ?? 20), MAX_PAGES_PER_CALL);
    const last = Math.min(totalPages, startPage + maxPages - 1);

    const pages: PdfText['pages'] = [];
    let chars = 0;
    let truncated = last < totalPages;
    for (let n = startPage; n <= last; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        text += item.str;
        if (item.hasEOL) text += '\n';
        else if (item.str && !text.endsWith(' ')) text += ' ';
      }
      // pdf.js sometimes emits a space as its own item; collapse what that doubles.
      text = text.replace(/[ \t]{2,}/g, ' ').replace(/[ \t]+\n/g, '\n').trim();
      page.cleanup();

      if (chars + text.length > MAX_CHARS_PER_CALL) {
        pages.push({ page: n, text: text.slice(0, MAX_CHARS_PER_CALL - chars) });
        truncated = true;
        break;
      }
      chars += text.length;
      pages.push({ page: n, text });
    }

    return {
      totalPages,
      startPage,
      pages,
      truncated,
      noTextLayer: pages.length > 0 && pages.every((p) => p.text === ''),
    };
  } finally {
    await task.destroy();
  }
}
