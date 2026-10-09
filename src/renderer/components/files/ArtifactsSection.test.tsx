import '@testing-library/jest-dom/vitest'
import { findPane } from '@/layout/tree'
import { useArtifactsStore } from '@/stores/files/artifactsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { type Workspace, useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { ARTIFACT_FILE_MAX_BYTES, type ArtifactListing } from '@shared/artifacts/artifacts'
import { act, cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { renderSettled } from '../../../../test/render'
import { ArtifactsSection } from './ArtifactsSection'

const DIR = '/data/artifacts/s1'

function listing(...files: [name: string, modified: number, size?: number][]): ArtifactListing {
  return {
    dir: DIR,
    pad: `${DIR}/PAD.md`,
    padModified: null,
    entries: files.map(([name, modified, size]) => ({
      name,
      path: `${DIR}/${name}`,
      size: size ?? 10,
      modified,
    })),
  }
}

function lists(value: ArtifactListing): void {
  vi.mocked(window.ostia.artifacts.list).mockResolvedValue(value)
}

function seedWorkspace(): void {
  const workspace: Workspace = {
    id: 's1',
    name: 'project',
    kind: 'terminal',
    workDir: '/home/me/project',
    state: 'idle',
  }
  useWorkspacesStore.setState({ workspaces: [workspace], activeWorkspaceId: 's1' })
  useLayoutStore.getState().ensure('s1')
}

function rowNames(): (string | null)[] {
  return screen
    .queryAllByTestId('artifact-row')
    .map((row) => row.querySelector('.file-name')?.textContent ?? null)
}

async function changedOnDisk(next: ArtifactListing): Promise<void> {
  lists(next)
  await act(() => useArtifactsStore.getState().refresh('s1'))
}

describe('ArtifactsSection', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let artifactsInit: ReturnType<typeof useArtifactsStore.getState>

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
    artifactsInit = useArtifactsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
    useArtifactsStore.setState(artifactsInit, true)
  })

  it('lists what main read for the active workspace, in main’s order', async () => {
    seedWorkspace()
    lists(listing(['new.md', Date.now()], ['page/index.html', Date.now() - 120_000]))
    await renderSettled(<ArtifactsSection workspaceId="s1" />)
    expect(window.ostia.artifacts.list).toHaveBeenCalledWith('s1')
    expect(rowNames()).toEqual(['new.md', 'page/index.html'])
    expect(screen.getAllByTestId('artifact-row')[0]).toHaveTextContent('just now')
    expect(screen.getAllByTestId('artifact-row')[1]).toHaveTextContent('2 min. ago')
  })

  it('shows only the pad row when the folder is empty', async () => {
    seedWorkspace()
    lists(listing())
    await renderSettled(<ArtifactsSection workspaceId="s1" />)
    expect(screen.queryAllByTestId('artifact-row')).toHaveLength(0)
    const list = screen.getByTestId('artifacts-section').querySelector('.artifacts-list')
    expect(list?.children).toHaveLength(1)
    expect(screen.getByTestId('artifact-pad')).toHaveTextContent('Scratch Pad')
  })

  it('pins the pad above the newest artifact', async () => {
    seedWorkspace()
    lists(listing(['new.md', 300]))
    await renderSettled(<ArtifactsSection workspaceId="s1" />)
    const list = screen.getByTestId('artifacts-section').querySelector('.artifacts-list')
    expect(list?.firstElementChild).toBe(screen.getByTestId('artifact-pad'))
  })

  it('opens the pad main made, never a path the window named', async () => {
    seedWorkspace()
    lists(listing())
    vi.mocked(window.ostia.artifacts.pad).mockResolvedValue(`${DIR}/PAD.md`)
    await renderSettled(<ArtifactsSection workspaceId="s1" />)
    await userEvent.click(screen.getByTestId('artifact-pad'))
    expect(window.ostia.artifacts.pad).toHaveBeenCalledWith('s1')
    const layout = useLayoutStore.getState().byWorkspace.s1
    expect(findPane(layout.root, layout.activePaneId)).toMatchObject({
      kind: 'editor',
      filePath: `${DIR}/PAD.md`,
    })
  })

  it('opens nothing when main could not make the pad', async () => {
    seedWorkspace()
    lists(listing())
    vi.mocked(window.ostia.artifacts.pad).mockResolvedValue(null)
    await renderSettled(<ArtifactsSection workspaceId="s1" />)
    await userEvent.click(screen.getByTestId('artifact-pad'))
    const layout = useLayoutStore.getState().byWorkspace.s1
    expect(findPane(layout.root, layout.activePaneId)?.kind).toBe('terminal')
  })

  it('marks the pad unread when an agent wrote it while it was closed, not while it is open', async () => {
    seedWorkspace()
    lists({ ...listing(), padModified: 100 })
    await renderSettled(<ArtifactsSection workspaceId="s1" />)
    await changedOnDisk({ ...listing(), padModified: 200 })
    expect(screen.getByTestId('artifact-pad').dataset.unread).toBe('true')
    vi.mocked(window.ostia.artifacts.pad).mockResolvedValue(`${DIR}/PAD.md`)
    await userEvent.click(screen.getByTestId('artifact-pad'))
    expect(screen.getByTestId('artifact-pad').dataset.unread).toBeUndefined()
    await changedOnDisk({ ...listing(), padModified: 300 })
    expect(screen.getByTestId('artifact-pad').dataset.unread).toBeUndefined()
  })

  it('renders nothing without a workspace', async () => {
    await renderSettled(<ArtifactsSection workspaceId={null} />)
    expect(screen.queryByTestId('artifacts-section')).toBeNull()
    expect(window.ostia.artifacts.list).not.toHaveBeenCalled()
  })

  it('marks a new or changed file unread, never the first listing', async () => {
    seedWorkspace()
    lists(listing(['a.md', 100], ['b.md', 100]))
    await renderSettled(<ArtifactsSection workspaceId="s1" />)
    expect(screen.queryAllByLabelText('New or changed')).toHaveLength(0)
    await changedOnDisk(listing(['c.md', 300], ['a.md', 200], ['b.md', 100]))
    const unread = screen
      .getAllByTestId('artifact-row')
      .filter((row) => row.dataset.unread === 'true')
      .map((row) => row.querySelector('.file-name')?.textContent)
    expect(unread).toEqual(['c.md', 'a.md'])
  })

  it('opens the file in the workspace and clears its mark on a click', async () => {
    seedWorkspace()
    lists(listing(['a.md', 100]))
    await renderSettled(<ArtifactsSection workspaceId="s1" />)
    await changedOnDisk(listing(['a.md', 200]))
    const row = screen.getByTestId('artifact-row')
    expect(row.dataset.unread).toBe('true')
    await userEvent.click(row)
    expect(screen.getByTestId('artifact-row').dataset.unread).toBeUndefined()
    const layout = useLayoutStore.getState().byWorkspace.s1
    expect(findPane(layout.root, layout.activePaneId)).toMatchObject({
      kind: 'editor',
      filePath: `${DIR}/a.md`,
    })
  })

  it('does not mark a file the human is looking at', async () => {
    seedWorkspace()
    lists(listing(['a.md', 100]))
    await renderSettled(<ArtifactsSection workspaceId="s1" />)
    act(() => useLayoutStore.getState().openFile('s1', `${DIR}/a.md`))
    vi.spyOn(document, 'hasFocus').mockReturnValue(true)
    await changedOnDisk(listing(['a.md', 200]))
    expect(screen.getByTestId('artifact-row').dataset.unread).toBeUndefined()
  })

  it('shows the size of a file too large to view and reveals the folder instead of opening it', async () => {
    seedWorkspace()
    lists(listing(['dump.bin', 100, ARTIFACT_FILE_MAX_BYTES + 1]))
    await renderSettled(<ArtifactsSection workspaceId="s1" />)
    const row = screen.getByTestId('artifact-row')
    expect(row).toHaveTextContent('16.0 MiB')
    await userEvent.click(row)
    expect(window.ostia.artifacts.reveal).toHaveBeenCalledWith('s1')
    const layout = useLayoutStore.getState().byWorkspace.s1
    expect(findPane(layout.root, layout.activePaneId)?.kind).toBe('terminal')
  })

  it('reveals the folder through main, by workspace id', async () => {
    seedWorkspace()
    lists(listing())
    await renderSettled(<ArtifactsSection workspaceId="s1" />)
    await userEvent.click(screen.getByRole('button', { name: 'Reveal artifacts folder' }))
    expect(window.ostia.artifacts.reveal).toHaveBeenCalledWith('s1')
  })
})
