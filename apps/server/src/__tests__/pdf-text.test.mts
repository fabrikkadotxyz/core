/**
 * M20: the text of an uploaded PDF, for agents. See docs/security.md, Threat 7.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { makePdf } from '../../../../scripts/fixtures/make-pdf.mjs';
import { extractPdfText, isPdf } from '../pdf-text.ts';

let fails = 0;
const eq = (label: string, got: unknown, want: unknown) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) console.log('ok  ', label);
  else { console.error('FAIL', label, '\n  got ', g, '\n  want', w); fails++; }
};

const three = makePdf(['Retry storms (part 1)', 'Idempotency keys', 'Page three']);

eq('a PDF is recognised by its header', isPdf(null, three), true);
eq('a text file is not a PDF', isPdf('text/plain', Buffer.from('hello')), false);

let r = await extractPdfText(three);
eq('every page is read, in order', r.pages.map((p) => p.text), ['Retry storms (part 1)', 'Idempotency keys', 'Page three']);
eq('total pages are reported', r.totalPages, 3);
eq('reading everything is not truncated', r.truncated, false);

r = await extractPdfText(three, { startPage: 2, maxPages: 1 });
eq('start_page and max_pages pick a window', r.pages, [{ page: 2, text: 'Idempotency keys' }]);
eq('a window short of the end says it is truncated', r.truncated, true);

r = await extractPdfText(three, { startPage: 99 });
eq('a start past the end clamps to the last page', r.pages.map((p) => p.page), [3]);

r = await extractPdfText(makePdf([null, null]));
eq('a PDF with no text layer is reported as such', r.noTextLayer, true);

r = await extractPdfText(makePdf(Array.from({ length: 60 }, (_, i) => `page ${i + 1}`)), { maxPages: 500 });
eq('one call reads at most 50 pages', r.pages.length, 50);
eq('…and says it stopped early', r.truncated, true);

let threw = false;
try {
  await extractPdfText(Buffer.from('%PDF-1.4 this is not really a pdf'));
} catch {
  threw = true;
}
eq('a malformed PDF fails cleanly instead of hanging', threw, true);

// Threat 7: pdf.js must not compile fonts with eval. v6 removed that path
// (CVE-2024-4367); this fails if an upgrade ever brings it back.
const require = createRequire(import.meta.url);
const root = dirname(require.resolve('pdfjs-dist/package.json'));
const built = ['legacy/build/pdf.mjs', 'legacy/build/pdf.worker.mjs'].map((f) => readFileSync(join(root, f), 'utf8')).join('\n');
eq('the pdf.js build contains no `new Function(`', /new Function\(/.test(built), false);
eq('the pdf.js build contains no direct `eval(`', /[^.\w]eval\(/.test(built), false);

if (fails) {
  console.error(`\n${fails} failure(s)`);
  process.exit(1);
}
