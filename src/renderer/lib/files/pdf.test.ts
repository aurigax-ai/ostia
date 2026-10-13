import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url', () => ({ default: 'pdf.worker.js' }))

afterEach(() => {
  vi.doUnmock('pdfjs-dist/legacy/build/pdf.mjs')
  vi.resetModules()
})

describe('loadPdfjs', () => {
  it('loads the library again after a failed load', async () => {
    vi.doMock('pdfjs-dist/legacy/build/pdf.mjs', () => {
      throw new Error('chunk failed')
    })
    const { loadPdfjs } = await import('./pdf')
    await expect(loadPdfjs()).rejects.toThrow()

    const pdfjs = { GlobalWorkerOptions: { workerSrc: '' } }
    vi.doMock('pdfjs-dist/legacy/build/pdf.mjs', () => pdfjs)
    const loaded = await loadPdfjs()

    expect(loaded.GlobalWorkerOptions.workerSrc).toBe('pdf.worker.js')
  })

  it('loads the library once for every caller', async () => {
    const factory = vi.fn(() => ({ GlobalWorkerOptions: { workerSrc: '' } }))
    vi.doMock('pdfjs-dist/legacy/build/pdf.mjs', factory)
    const { loadPdfjs } = await import('./pdf')

    expect(await loadPdfjs()).toBe(await loadPdfjs())
    expect(factory).toHaveBeenCalledTimes(1)
  })
})
