/**
 * SyncTeX forward search: which part of which PDF page a range of source lines
 * produced. Used to point at what an agent just changed.
 *
 * Coordinates in a .synctex file are scaled points from the page's top-left
 * corner (the 1in margin included), with `y` on the baseline. We convert to PDF
 * points, which is what the PDF renderer's viewport uses.
 */

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SyncHit {
  page: number;
  rects: Rect[];
}

/** sp → big points: 65536 sp per TeX point, 72.27 TeX points per inch. */
const SP_TO_BP = 72 / 72.27 / 65536;

export class SyncTex {
  private constructor(
    private readonly tags: Map<string, number>,
    /** Per page: [tag, line, x, y, w, h, d] records. */
    private readonly pages: Map<number, number[][]>,
  ) {}

  static async parse(gz: Uint8Array): Promise<SyncTex> {
    const stream = new Blob([gz as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new DecompressionStream('gzip'));
    const text = await new Response(stream).text();
    const tags = new Map<string, number>();
    const pages = new Map<number, number[][]>();
    let page = 0;

    for (const line of text.split('\n')) {
      const input = line.match(/^Input:(\d+):(.+)$/);
      if (input) {
        // "/project/./main.tex" → "main.tex"
        tags.set(input[2]!.replace(/^\/project\//, '').replace(/^\.\//, ''), Number(input[1]));
        continue;
      }
      if (line.startsWith('{')) {
        page = Number(line.slice(1));
        pages.set(page, []);
        continue;
      }
      // (tag,line:x,y:W,H,D  hbox      h… / [… boxes      x,k,g,$ points
      const m = line.match(/^[([hvxkg$](\d+),(\d+):(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+))?/);
      if (m && page) {
        pages.get(page)!.push(m.slice(1).map((v) => (v === undefined ? 0 : Number(v))));
      }
    }
    return new SyncTex(tags, pages);
  }

  /** Where lines [start, end] of `file` landed — the first page they appear on. */
  forward(file: string, start: number, end: number): SyncHit | null {
    const tag = this.tags.get(file);
    if (tag === undefined) return null;

    for (const [page, records] of [...this.pages].sort(([a], [b]) => a - b)) {
      const hits = records.filter(([t, l]) => t === tag && l! >= start && l! <= end);
      if (hits.length === 0) continue;

      // Group by baseline: one highlight per line of output, spanning its words.
      const lines = new Map<number, { x0: number; x1: number; h: number; d: number }>();
      for (const [, , x, y, w, h, d] of hits) {
        // A full-page vbox says nothing about where the change is.
        if (h! > 30 * 65536 * 10) continue;
        const cur = lines.get(y!) ?? { x0: Infinity, x1: -Infinity, h: 0, d: 0 };
        cur.x0 = Math.min(cur.x0, x!);
        cur.x1 = Math.max(cur.x1, x! + Math.max(w!, 0));
        cur.h = Math.max(cur.h, h!);
        cur.d = Math.max(cur.d, d!);
        lines.set(y!, cur);
      }
      const rects = [...lines].map(([y, l]) => {
        // Points without a box (glue, kerns) get a line's height and a minimum width.
        const h = l.h || 8 * 65536;
        const x1 = Math.max(l.x1, l.x0 + 40 * 65536);
        return { x: l.x0 * SP_TO_BP, y: (y - h) * SP_TO_BP, w: (x1 - l.x0) * SP_TO_BP, h: (h + l.d) * SP_TO_BP };
      });
      if (rects.length) return { page, rects: rects.slice(0, 40) };
    }
    return null;
  }
}
