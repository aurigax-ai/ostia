import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { PaneNode } from '../layout/types'
import { unsavedFilesOf } from '../lib/closeConfirm'
import { useEditorStatus } from '../stores/editorStatusStore'
import { Pane } from './Pane'

const file: PaneNode = {
  type: 'pane',
  id: 'pe',
  kind: 'editor',
  title: 'notes.txt',
  filePath: '/w/notes.txt',
}

let init: ReturnType<typeof useEditorStatus.getState>

beforeAll(() => {
  init = useEditorStatus.getState()
})

afterEach(() => {
  cleanup()
  useEditorStatus.setState(init, true)
})

describe('pane tab disk marker', () => {
  it('ERL-C15 shows a warning dot naming the problem instead of the unsaved mark', () => {
    act(() => {
      useEditorStatus.getState().setDirty('/w/notes.txt', true)
      useEditorStatus.getState().setDisk('/w/notes.txt', 'changed')
    })
    render(<Pane tabs={[file]} shownId="pe" active />)
    const tab = screen.getByRole('tab', { name: /notes\.txt/ })
    expect(tab).not.toHaveTextContent('•')
    expect(screen.getByRole('img', { name: 'Changed on disk' })).toBeInTheDocument()
  })

  it('ERL-C16 strikes through a deleted file and clears when it comes back', () => {
    act(() => useEditorStatus.getState().setDisk('/w/notes.txt', 'deleted'))
    const { container } = render(<Pane tabs={[file]} shownId="pe" active />)
    expect(screen.getByRole('img', { name: 'Deleted on disk' })).toBeInTheDocument()
    expect(container.querySelector('.pane-tab .title')).toHaveClass('line-through')
    act(() => useEditorStatus.getState().setDisk('/w/notes.txt', null))
    expect(screen.queryByRole('img', { name: 'Deleted on disk' })).toBeNull()
    expect(container.querySelector('.pane-tab .title')).not.toHaveClass('line-through')
  })
})

describe('unsaved files', () => {
  it('ERL-C17 lists a clean file that was deleted on disk', () => {
    expect(unsavedFilesOf([file], {}, { '/w/notes.txt': 'deleted' })).toEqual(['/w/notes.txt'])
  })

  it('ERL-C18 does not list a clean file that was only changed and reloaded', () => {
    expect(unsavedFilesOf([file], {}, {})).toEqual([])
  })

  it('lists a remote file with unsaved edits, so closing asks about it too', () => {
    const remote: PaneNode = {
      type: 'pane',
      id: 'pr',
      kind: 'editor',
      title: 'app.conf',
      filePath: 'remote://abcdef012345/srv/app/app.conf',
    }
    expect(
      unsavedFilesOf([file, remote], { 'remote://abcdef012345/srv/app/app.conf': true }),
    ).toEqual(['remote://abcdef012345/srv/app/app.conf'])
  })
})
