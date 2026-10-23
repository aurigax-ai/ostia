import '@testing-library/jest-dom/vitest'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useViewModeStore } from '@/stores/files/viewModeStore'
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
  afterEach(() => {
    cleanup()
    useViewModeStore.setState(useViewModeStore.getInitialState(), true)
  })

  it('publishes the option viewer button for the tab row and draws nothing over the text', () => {
    const show = vi.fn()
    const { container } = render(
      <EditorModes {...baseProps} optionViewer={{ name: 'Table', show }} />,
    )
    const mode = useViewModeStore.getState().byPane.p
    expect(mode).toMatchObject({ icon: 'viewer', label: 'Open with Table' })
    mode?.act()
    expect(show).toHaveBeenCalledTimes(1)
    expect(container).toBeEmptyDOMElement()
  })

  it('publishes the run toggle', () => {
    const setRunChoice = vi.fn()
    render(<EditorModes {...baseProps} filePath="/w/a.html" runnable setRunChoice={setRunChoice} />)
    const mode = useViewModeStore.getState().byPane.p
    expect(mode).toMatchObject({ icon: 'run', label: 'Run page in preview' })
    mode?.act()
    expect(setRunChoice).toHaveBeenCalledWith({ file: '/w/a.html', on: true })
  })

  it('publishes nothing with nothing to offer, and withdraws on unmount', () => {
    const { unmount } = render(<EditorModes {...baseProps} />)
    expect(useViewModeStore.getState().byPane.p).toBeUndefined()
    cleanup()
    render(<EditorModes {...baseProps} optionViewer={{ name: 'Table', show: vi.fn() }} />)
    expect(useViewModeStore.getState().byPane.p).toBeDefined()
    cleanup()
    expect(useViewModeStore.getState().byPane.p).toBeUndefined()
    unmount()
  })
})
