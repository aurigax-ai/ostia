import type { ArtifactVersionContent } from '@shared/artifacts/artifacts'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useArtifactVersionsStore } from '@/stores/files/artifactVersionsStore'
import {
  focusSurfaceWhenReady,
  mountSurface,
  releaseSurfaces,
  setFocusTarget,
  surfaceHost,
} from '@/stores/workspaces/surfaceSlotsStore'

const { FileView } = await import('./FileView')

const PANE = 'version-pane'
const FILE = '/data/artifacts/w1/report.md'
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve)))

function showVersion(content: ArtifactVersionContent): void {
  act(() => {
    useArtifactVersionsStore.setState({
      byPane: {
        [PANE]: {
          workspaceId: 'w1',
          path: FILE,
          version: { id: 'v1', time: 1, size: 1, current: false },
          content,
          modifiedAtOpen: null,
        },
      },
    })
  })
}

describe('FileView keyboard target', () => {
  let versionsInit: ReturnType<typeof useArtifactVersionsStore.getState>

  beforeAll(() => {
    versionsInit = useArtifactVersionsStore.getState()
  })

  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => 'blob:version')
    URL.revokeObjectURL = vi.fn()
    vi.mocked(window.ostia.fs.readBinary).mockResolvedValue({
      ok: true,
      data: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    })
  })

  afterEach(() => {
    cleanup()
    releaseSurfaces(new Set())
    document.body.innerHTML = ''
    useArtifactVersionsStore.setState(versionsInit, true)
  })

  it('a pane showing versions keeps taking no keyboard while they switch between an image and text', async () => {
    const slot = document.createElement('div')
    document.body.appendChild(slot)
    mountSurface(PANE, slot)
    showVersion({ file: '/h/v1.svg', type: 'svg', sources: {} })
    render(<FileView workspaceId="w1" paneId={PANE} filePath={FILE} />, {
      container: surfaceHost(PANE),
    })
    await settle()
    showVersion({ file: '/h/v3.md', type: 'markdown', sources: { 'report.md': '# Third' } })
    await screen.findByText('# Third')

    focusSurfaceWhenReady(PANE, () => true)
    const late = document.createElement('textarea')
    surfaceHost(PANE).appendChild(late)
    const unregister = setFocusTarget(PANE, () => late)
    await settle()
    unregister()

    expect(document.activeElement).not.toBe(late)
  })
})
