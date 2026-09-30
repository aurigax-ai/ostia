import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'

export type Pdfjs = typeof import('pdfjs-dist/legacy/build/pdf.mjs')
export type PdfDocument = import('pdfjs-dist').PDFDocumentProxy
export type PdfPage = import('pdfjs-dist').PDFPageProxy

let loading: Promise<Pdfjs> | null = null

export function loadPdfjs(): Promise<Pdfjs> {
  loading ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
    return pdfjs
  })
  return loading
}

export async function openPdf(data: Uint8Array): Promise<PdfDocument> {
  const pdfjs = await loadPdfjs()
  return pdfjs.getDocument({ data }).promise
}
