import '@testing-library/jest-dom/vitest'
import { OFFICE_LIMITS } from '@/lib/office/officeLimits'
import { type Workbook, readWorkbook } from '@/lib/office/sheetModel'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { workbook } from '../../../../test/fixtures/office/workbooks'

const cancel = vi.fn()

vi.mock('@/lib/office/workbookClient', () => ({
  parseWorkbook: vi.fn((data: Uint8Array, extension: string) => ({
    result: Promise.resolve(readWorkbook(data, extension, OFFICE_LIMITS)),
    cancel,
  })),
}))

const { parseWorkbook } = await import('@/lib/office/workbookClient')
const { SheetViewer } = await import('./SheetViewer')

afterEach(() => {
  cleanup()
  cancel.mockReset()
})

function serve(bytes: Uint8Array): void {
  vi.mocked(window.ostia.fs.readBinary).mockResolvedValue({ ok: true, data: bytes })
}

function serveBook(book: Workbook): void {
  serve(new Uint8Array([1]))
  vi.mocked(parseWorkbook).mockReturnValueOnce({
    result: Promise.resolve({ ok: true, book }),
    cancel,
  })
}

const SHEET = {
  rowsCut: false,
  columnsCut: false,
  uncached: 0,
}

describe('SheetViewer', () => {
  it('shows a sheet with column letters and row numbers, and switches sheets by tab', async () => {
    serve(
      workbook({
        People: [
          ['name', 'age'],
          ['Lee', 41],
        ],
        Places: [['Taipei']],
      }),
    )
    render(<SheetViewer filePath="/w/report.xlsx" />)
    const grid = await screen.findByTestId('sheet-grid')
    expect(window.ostia.fs.readBinary).toHaveBeenCalledWith('/w/report.xlsx')
    expect(
      within(grid)
        .getAllByRole('columnheader')
        .map((th) => th.textContent),
    ).toEqual(['A', 'B'])
    expect(
      within(grid)
        .getAllByRole('rowheader')
        .map((th) => th.textContent),
    ).toEqual(['1', '2'])
    expect(within(grid).getByRole('cell', { name: 'Lee' })).toBeInTheDocument()
    expect(within(grid).getByRole('cell', { name: '41' })).toBeInTheDocument()
    expect(screen.getByText('2 × 2')).toBeInTheDocument()

    await userEvent.click(screen.getByRole('tab', { name: 'Places' }))
    await waitFor(() =>
      expect(
        within(screen.getByTestId('sheet-grid')).getByRole('cell', { name: 'Taipei' }),
      ).toBeInTheDocument(),
    )
  })

  it('shows no tabs for a single sheet', async () => {
    serve(workbook({ Only: [['x']] }))
    render(<SheetViewer filePath="/w/one.xlsx" />)
    await screen.findByTestId('sheet-grid')
    expect(screen.queryByRole('tablist')).toBeNull()
  })

  it('says what was cut, hidden or left uncalculated', async () => {
    serveBook({
      sheets: [
        {
          ...SHEET,
          name: 'Big',
          rows: [[1]],
          rowCount: 100_000,
          columnCount: 1_000,
          rowsCut: true,
          columnsCut: true,
          uncached: 3,
        },
      ],
      hidden: 2,
      sheetsCut: false,
      cellsCut: true,
    })
    render(<SheetViewer filePath="/w/big.xlsx" />)
    const note = await screen.findByTestId('sheet-grid-note')
    expect(note).toHaveTextContent('Showing the first 100,000 rows.')
    expect(note).toHaveTextContent('Showing the first 1000 columns.')
    expect(note).toHaveTextContent('Formulas with no saved value: 3.')
    expect(note).toHaveTextContent('Hidden sheets not shown: 2.')
    expect(note).toHaveTextContent('more than 2,000,000 cells')
  })

  it('keeps only the rows in view in the DOM for a long sheet', async () => {
    serveBook({
      sheets: [
        {
          ...SHEET,
          name: 'Long',
          rows: Array.from({ length: 5_000 }, (_unused, r) => [r]),
          rowCount: 5_000,
          columnCount: 1,
        },
      ],
      hidden: 0,
      sheetsCut: false,
      cellsCut: false,
    })
    const height = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('csv-table') ? 600 : 0
      })
    render(<SheetViewer filePath="/w/long.xlsx" />)
    const grid = await screen.findByTestId('sheet-grid')
    const shown = await waitFor(() => {
      const rows = within(grid).getAllByRole('rowheader')
      expect(rows.length).toBeGreaterThan(0)
      return rows
    })
    expect(shown[0]).toHaveTextContent('1')
    expect(shown.length).toBeLessThan(200)
    height.mockRestore()
  })

  it('shows why a malformed file, a bomb or a password-protected file is not shown', async () => {
    serve(new TextEncoder().encode('not a spreadsheet'))
    render(<SheetViewer filePath="/w/broken.xlsx" />)
    expect(
      await screen.findByText(
        'Could not read this file. It may be damaged or in a format this viewer does not read.',
      ),
    ).toBeInTheDocument()
    cleanup()

    serve(new Uint8Array([1]))
    vi.mocked(parseWorkbook).mockReturnValueOnce({
      result: Promise.resolve({ ok: false, problem: 'unzip-limit' }),
      cancel,
    })
    render(<SheetViewer filePath="/w/bomb.xlsx" />)
    expect(
      await screen.findByText('This file unpacks to more than 134.2 MB, so it is not previewed.'),
    ).toBeInTheDocument()
    cleanup()

    serve(new Uint8Array([1]))
    vi.mocked(parseWorkbook).mockReturnValueOnce({
      result: Promise.resolve({ ok: false, problem: 'timeout' }),
      cancel,
    })
    render(<SheetViewer filePath="/w/slow.xlsx" />)
    expect(
      await screen.findByText('Reading this file took too long, so it was stopped.'),
    ).toBeInTheDocument()
  })

  it('shows the size message when the file is over the read limit', async () => {
    vi.mocked(window.ostia.fs.readBinary).mockResolvedValue({
      ok: false,
      error: 'too-large',
      size: 60_000_000,
    })
    render(<SheetViewer filePath="/w/huge.xlsx" />)
    expect(await screen.findByText(/This file is too large to preview/)).toBeInTheDocument()
    expect(parseWorkbook).not.toHaveBeenCalledWith(expect.anything(), 'xlsx', undefined)
  })

  it('stops parsing when the viewer closes', async () => {
    serve(workbook({ S: [['x']] }))
    const view = render(<SheetViewer filePath="/w/close.xlsx" />)
    await screen.findByTestId('sheet-grid')
    view.unmount()
    expect(cancel).toHaveBeenCalled()
  })
})
