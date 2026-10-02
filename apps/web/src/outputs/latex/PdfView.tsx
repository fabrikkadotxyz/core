/**
 * The compiled paper. Rendered with PDF.js rather than the browser's own viewer
 * so that a recompile every few seconds does not throw the reader back to page
 * one, and so a changed region can be outlined on the page.
 */
import { useEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { SyncHit } from './synctex.ts';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

/** How long the outline stays before fading: long enough to find, not forever. */
const MARK_MS = 6000;

export function PdfView({
  pdf,
  highlight,
}: {
  pdf: Uint8Array | null;
  /** Outline this region and scroll to it. `key` changes to re-trigger. */
  highlight: (SyncHit & { key: string }) | null;
}) {
  const host = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [rendered, setRendered] = useState(0);
  const scales = useRef<number[]>([]);
  /**
   * A highlight scrolls the reader once. If a recompile replaces the pages while
   * it is still showing, it is redrawn in place — without scrolling again.
   */
  const applied = useRef<{ key: string; at: number } | null>(null);

  // Re-render on resize: the rail is user-resizable.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.round(e!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const el = host.current;
    if (!pdf || !el || width === 0) return;
    let cancelled = false;
    // PDF.js takes ownership of the buffer it is given; keep ours.
    const task = pdfjs.getDocument({ data: pdf.slice() });

    (async () => {
      const doc = await task.promise;
      const pages: HTMLDivElement[] = [];
      const nextScales: number[] = [];
      const dpr = window.devicePixelRatio || 1;
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const base = page.getViewport({ scale: 1 });
        const scale = (width - 2) / base.width;
        const viewport = page.getViewport({ scale });
        const canvas = document.createElement('canvas');
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        await page.render({ canvas, viewport, transform: dpr === 1 ? undefined : [dpr, 0, 0, dpr, 0, 0] }).promise;
        if (cancelled) return;
        const wrap = document.createElement('div');
        wrap.className = 'pdf-page';
        wrap.dataset.page = String(n);
        wrap.appendChild(canvas);
        pages.push(wrap);
        nextScales.push(scale);
      }
      if (cancelled) return;
      // Swap all pages at once, after rendering off-screen: no flash, and the
      // scroll position survives because the pages are the same height.
      el.replaceChildren(...pages);
      scales.current = nextScales;
      setRendered((r) => r + 1);
    })().catch(() => {});

    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [pdf, width]);

  useEffect(() => {
    const el = host.current;
    if (!el || !highlight) return;
    const again = applied.current?.key === highlight.key;
    if (again && Date.now() - applied.current!.at > MARK_MS) return;
    const wrap = el.querySelector<HTMLDivElement>(`.pdf-page[data-page="${highlight.page}"]`);
    const scale = scales.current[highlight.page - 1];
    if (!wrap || !scale) return;
    if (!again) applied.current = { key: highlight.key, at: Date.now() };
    const remaining = MARK_MS - (Date.now() - applied.current!.at);
    wrap.querySelectorAll('.pdf-mark').forEach((m) => m.remove());
    let top = Infinity;
    for (const r of highlight.rects) {
      const mark = document.createElement('div');
      mark.className = 'pdf-mark';
      mark.style.left = `${r.x * scale - 3}px`;
      mark.style.top = `${r.y * scale - 2}px`;
      mark.style.width = `${r.w * scale + 6}px`;
      mark.style.height = `${r.h * scale + 4}px`;
      wrap.appendChild(mark);
      top = Math.min(top, r.y * scale);
    }
    if (!again) {
      const scroller = el.closest('.rail') ?? el;
      const offset = wrap.offsetTop + (Number.isFinite(top) ? top : 0) - 120;
      scroller.scrollTo({ top: Math.max(0, offset), behavior: 'smooth' });
    }
    // The outline says "here"; it should not stay forever and become noise.
    setTimeout(() => wrap.querySelectorAll('.pdf-mark').forEach((m) => m.classList.add('fade')), remaining);
  }, [highlight, rendered]);

  return (
    <div className="pdf-view">
      {!pdf && <p className="muted small">The PDF appears here after the first build.</p>}
      <div ref={host} className="pdf-pages" />
    </div>
  );
}
