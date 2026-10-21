import { viewerDocumentUrl } from '@aurigax-ai/ostia-extension-sdk/viewer'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import * as pdfjs from 'pdfjs-dist'

const RANGE_CHUNK = 1 << 17

pdfjs.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.js', location.href).href

export { pdfjs }

export type PdfDocument = PDFDocumentProxy

export function openPdf(): Promise<PdfDocument> {
  return pdfjs.getDocument({
    url: viewerDocumentUrl(),
    rangeChunkSize: RANGE_CHUNK,
    disableAutoFetch: true,
    cMapUrl: new URL('cmaps/', location.href).href,
    standardFontDataUrl: new URL('standard_fonts/', location.href).href,
    wasmUrl: new URL('wasm/', location.href).href,
  }).promise
}

export function isPasswordError(error: unknown): boolean {
  return error instanceof pdfjs.PasswordException
}
