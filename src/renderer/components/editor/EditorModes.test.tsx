import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EditorModes } from './EditorModes'

const baseProps = {
  workspaceId: 'w',
  paneId: 'p',
  filePath: '/w/data.csv',
  visible: true,
  selectionSend: { open: vi.fn() },
  running: false,
  runnable: false,
  setRunChoice: vi.fn(),
  overlayRef: { current: null },
}

describe('EditorModes', () => {
  afterEach(cleanup)

  it('floats the option viewer button in the file actions pill', async () => {
    const show = vi.fn()
    render(<EditorModes {...baseProps} optionViewer={{ name: 'Table', show }} />)
    const pill = screen.getByRole('toolbar', { name: 'File actions' })
    await userEvent.click(within(pill).getByRole('button', { name: 'Open with Table' }))
    expect(show).toHaveBeenCalledTimes(1)
  })

  it('floats the run toggle in the same pill', async () => {
    const setRunChoice = vi.fn()
    render(<EditorModes {...baseProps} filePath="/w/a.html" runnable setRunChoice={setRunChoice} />)
    const pill = screen.getByRole('toolbar', { name: 'File actions' })
    await userEvent.click(within(pill).getByRole('button', { name: 'Run page in preview' }))
    expect(setRunChoice).toHaveBeenCalledWith({ file: '/w/a.html', on: true })
  })

  it('draws no pill with nothing to offer', () => {
    render(<EditorModes {...baseProps} />)
    expect(screen.queryByRole('toolbar')).toBeNull()
  })
})
