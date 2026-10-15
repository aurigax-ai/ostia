import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderSettled } from '../../../../test/render'
import { CsvTable, CsvTableView } from './CsvTable'

afterEach(cleanup)

describe('CsvTable', () => {
  it('shows the first row as column headers and the rest as rows', async () => {
    await renderSettled(
      <CsvTable source={'city,count\nTaipei,3\n"Hsinchu, East",4\n'} delimiter="," />,
    )
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3))
    expect(screen.getAllByRole('columnheader').map((th) => th.textContent)).toEqual([
      'city',
      'count',
    ])
    expect(screen.getByRole('cell', { name: 'Hsinchu, East' })).toBeInTheDocument()
    expect(screen.queryByTestId('csv-table-note')).toBeNull()
  })

  it('shows cell text as text, never as markup or a formula', async () => {
    await renderSettled(
      <CsvTable
        source={'a,b\n<img src=x onerror=alert(1)>,"=HYPERLINK(""http://x"")"\n'}
        delimiter=","
      />,
    )
    await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2))
    const table = screen.getByTestId('csv-table')
    expect(table.querySelector('img, a, script')).toBeNull()
    expect(table).toHaveTextContent('<img src=x onerror=alert(1)>')
    expect(table).toHaveTextContent('=HYPERLINK("http://x")')
  })

  it('says so when it shows only the first rows', async () => {
    await renderSettled(
      <CsvTableView
        table={{ header: ['n'], rows: [['0'], ['1']], more: true, columnsCut: false }}
      />,
    )
    expect(screen.getByTestId('csv-table-note')).toHaveTextContent('Showing the first 2 rows.')
    expect(screen.getAllByRole('row')).toHaveLength(3)
  })

  it('keeps only the rows in view in the DOM for a long table, and all of them when static', async () => {
    const rows = Array.from({ length: 5_000 }, (_unused, i) => [String(i)])
    const table = { header: ['n'], rows, more: false, columnsCut: false }
    const height = vi
      .spyOn(HTMLElement.prototype, 'offsetHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.classList.contains('csv-table') ? 600 : 0
      })
    await renderSettled(<CsvTableView table={table} />)
    const shown = await waitFor(() => {
      const cells = screen.getAllByRole('cell')
      expect(cells.length).toBeGreaterThan(0)
      return cells
    })
    expect(shown[0]).toHaveTextContent('0')
    expect(shown.length).toBeLessThan(200)
    height.mockRestore()
    cleanup()
    await renderSettled(<CsvTableView table={table} windowed={false} />)
    expect(screen.getAllByRole('cell')).toHaveLength(5_000)
  })
})
