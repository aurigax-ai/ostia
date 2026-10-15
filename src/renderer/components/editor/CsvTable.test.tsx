import '@testing-library/jest-dom/vitest'
import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
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

  it('says so when it shows only the first 5,000 rows', async () => {
    await renderSettled(
      <CsvTableView
        table={{ header: ['n'], rows: [['0'], ['1']], more: true, columnsCut: false }}
      />,
    )
    expect(screen.getByTestId('csv-table-note')).toHaveTextContent('Showing the first 5,000 rows.')
    expect(screen.getAllByRole('row')).toHaveLength(3)
  })
})
