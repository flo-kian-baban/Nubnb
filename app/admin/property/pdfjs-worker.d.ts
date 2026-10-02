// PDF.js ships its worker without types. PdfPages imports it only to hand it to PDF.js as
// `globalThis.pdfjsWorker`, which PDF.js reads for its WorkerMessageHandler.
declare module "pdfjs-dist/build/pdf.worker.min.mjs" {
  export const WorkerMessageHandler: unknown;
}
