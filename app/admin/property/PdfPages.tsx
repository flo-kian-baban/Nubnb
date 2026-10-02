"use client";

/**
 * The statement preview's pages, drawn by PDF.js from the very bytes Finish
 * stores (2026-10-01, on Kian's note that the preview's edges were not clean).
 *
 * The preview used to be the browser's own PDF viewer in an iframe, which
 * paints its background, margins, page shadow and scrollbar round the page:
 * uneven dark bands inside the card, differing from one browser and one
 * Chrome version to the next. Here each page is a canvas exactly the card's
 * width, at the screen's pixel density, so the page meets the card's rounded
 * edge with nothing between, in every browser, headless ones included. A
 * statement of several pages scrolls inside the card.
 *
 * PDF.js is loaded on demand, the first time a preview is drawn, and its
 * worker code runs on this thread ("fake worker": a statement is one or two
 * pages, parsed and drawn in milliseconds), so no worker file has to be
 * served from a URL of its own. A new drawing replaces the old pages only
 * once all of its pages are drawn, so typing never shows a blank card; a
 * drawing overtaken by newer bytes or a new width is dropped.
 */

import { useEffect, useRef, useState } from "react";
import styles from "./page.module.css";

type PdfJs = typeof import("pdfjs-dist");

let pdfJs: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  if (!pdfJs) {
    pdfJs = (async () => {
      const worker = await import("pdfjs-dist/build/pdf.worker.min.mjs");
      (globalThis as { pdfjsWorker?: unknown }).pdfjsWorker = worker;
      return import("pdfjs-dist");
    })();
    // A failed load (a chunk that did not arrive) is tried again on the next drawing.
    pdfJs.catch(() => {
      pdfJs = null;
    });
  }
  return pdfJs;
}

export function PdfPages({ bytes, label }: { bytes: Uint8Array | null; label: string }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [density, setDensity] = useState(1);
  const [failed, setFailed] = useState<string | null>(null);

  // ── The card's width in CSS pixels, and the screen's pixel density: the pages are drawn to both ──
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    // Moving the window to a screen of another density draws the pages again, sharp on the new one.
    const query = window.matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    const update = () => setDensity(window.devicePixelRatio || 1);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, [density]);

  // ── Draw every page, then swap them in at once ──
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    if (!bytes) {
      box.replaceChildren();
      return;
    }
    if (width === 0) return;
    let stale = false;
    (async () => {
      const pdfjs = await loadPdfJs();
      // getDocument takes the buffer over; the caller's bytes stay theirs.
      const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise;
      try {
        const pages: HTMLCanvasElement[] = [];
        for (let n = 1; n <= doc.numPages; n++) {
          if (stale) return;
          const page = await doc.getPage(n);
          const size = page.getViewport({ scale: 1 });
          // Never fewer device pixels than the page covers; its shape on screen is the page's own, not the
          // rounded pixel counts', so one page fills the Letter-shaped card to the fraction of a pixel.
          const pixelsWide = Math.ceil(width * density);
          const viewport = page.getViewport({ scale: pixelsWide / size.width });
          const canvas = document.createElement("canvas");
          canvas.width = pixelsWide;
          canvas.height = Math.ceil(viewport.height);
          canvas.style.aspectRatio = `${size.width} / ${size.height}`;
          canvas.className = styles.previewPage;
          canvas.setAttribute("role", "img");
          canvas.setAttribute("aria-label", `${label}, page ${n} of ${doc.numPages}`);
          await page.render({ canvas, viewport }).promise;
          pages.push(canvas);
        }
        if (stale) return;
        box.replaceChildren(...pages);
        setFailed(null);
      } finally {
        void doc.destroy();
      }
    })().catch((err: unknown) => {
      if (!stale) setFailed(err instanceof Error ? err.message : String(err));
    });
    return () => {
      stale = true;
    };
  }, [bytes, width, density, label]);

  // ── If PDF.js cannot draw it, the PDF itself is still a click away ──
  const openPdf = () => {
    if (!bytes) return;
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
    window.open(url, "_blank", "noopener");
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  return (
    <>
      <div ref={boxRef} className={styles.previewPages} />
      {failed !== null && bytes && (
        <div className={styles.previewEmpty} role="alert" title={failed}>
          <span>
            The preview could not be drawn.{" "}
            <button type="button" className={styles.linkButton} onClick={openPdf}>
              Open the PDF
            </button>
          </span>
        </div>
      )}
    </>
  );
}
