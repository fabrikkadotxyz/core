/**
 * Minimal, valid PDFs for tests: no binary fixtures in the repo, and the text on
 * every page is known exactly.
 *
 *   makePdf(['page one text', 'page two text'])  → a PDF with a text layer
 *   makePdf([null, null])                         → pages with only a drawn box,
 *                                                   i.e. no text layer (a "scan")
 */
export function makePdf(pages) {
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length; // object number
  };

  const catalog = add(null); // filled in once the page tree exists
  const tree = add(null);
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

  const kids = pages.map((text) => {
    const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
    const stream =
      text === null
        ? '0.5 g 72 600 200 100 re f'
        : `BT /F1 14 Tf 72 720 Td (${esc(text)}) Tj ET`;
    const content = add(`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
    return add(
      `<< /Type /Page /Parent ${tree} 0 R /MediaBox [0 0 612 792] ` +
        `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`,
    );
  });

  objects[catalog - 1] = `<< /Type /Catalog /Pages ${tree} 0 R >>`;
  objects[tree - 1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
