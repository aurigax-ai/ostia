import '@testing-library/jest-dom/vitest'
import type { ArtifactListing, ArtifactVersion } from '@shared/artifacts/artifacts'
import type { PreviewEvent } from '@shared/artifacts/htmlPreview'
import { act, cleanup, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useSettingsStore } from '@/stores/app/settingsStore'
import { useArtifactsStore } from '@/stores/files/artifactsStore'
import { useArtifactVersionsStore } from '@/stores/files/artifactVersionsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import {
  focusSurface,
  mountSurface,
  releaseSurfaces,
  setFocusTarget,
  surfaceHost,
} from '@/stores/workspaces/surfaceSlotsStore'
import { renderSettled } from '../../../../test/render'
import { ArtifactVersionsButton, VersionView } from './ArtifactVersions'

vi.mock('@/lib/attention/workspaceActivity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/attention/workspaceActivity')>()),
  usePaneVisible: () => true,
}))

const DIR = '/data/artifacts/s1'
const FILE = `${DIR}/plan.md`
const HISTORY = '/data/artifacts/.history/s1/plan.md'
const T0 = Date.UTC(2026, 9, 14, 12)

function listing(modified: number): ArtifactListing {
  return {
    dir: DIR,
    pad: `${DIR}/PAD.md`,
    padModified: null,
    entries: [{ name: 'plan.md', path: FILE, size: 10, modified }],
  }
}

const VERSIONS: ArtifactVersion[] = [4, 3, 2, 1].map((n) => ({
  id: `${T0 + n * 60_000}-v${n}.html`,
  time: T0 + n * 60_000,
  size: 100 * n,
  current: n === 4,
}))

async function load(modified: number): Promise<void> {
  vi.mocked(window.ostia.artifacts.list).mockResolvedValue(listing(modified))
  await act(() => useArtifactsStore.getState().refresh('s1'))
}

describe('artifact versions', () => {
  let artifactsInit: ReturnType<typeof useArtifactsStore.getState>
  let versionsInit: ReturnType<typeof useArtifactVersionsStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let settingsInit: ReturnType<typeof useSettingsStore.getState>

  beforeAll(() => {
    artifactsInit = useArtifactsStore.getState()
    versionsInit = useArtifactVersionsStore.getState()
    layoutInit = useLayoutStore.getState()
    settingsInit = useSettingsStore.getState()
  })

  beforeEach(() => {
    vi.mocked(window.ostia.artifacts.versions).mockResolvedValue(VERSIONS)
    vi.mocked(window.ostia.artifacts.version).mockImplementation(async (_w, _p, id) => ({
      file: `${HISTORY}/${id}`,
      type: 'markdown',
      sources: { 'plan.md': `# Plan from ${id}` },
    }))
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useArtifactsStore.setState(artifactsInit, true)
    useArtifactVersionsStore.setState(versionsInit, true)
    useLayoutStore.setState(layoutInit, true)
    useSettingsStore.setState(settingsInit, true)
  })

  it('the versions button in a pane header leaves the pane its own keyboard target', async () => {
    await load(T0)
    const slot = document.createElement('div')
    document.body.appendChild(slot)
    mountSurface('p1', slot)
    const input = document.createElement('textarea')
    surfaceHost('p1').appendChild(input)
    const unregister = setFocusTarget('p1', () => input)
    try {
      await renderSettled(<ArtifactVersionsButton workspaceId="s1" paneId="p1" filePath={FILE} />)
      focusSurface('p1')
      expect(document.activeElement).toBe(input)
    } finally {
      unregister()
      releaseSurfaces(new Set())
      slot.remove()
    }
  })

  it('PRT-C46 shows a picked version read-only with its bar, and goes back to the latest', async () => {
    await load(1000)
    await renderSettled(
      <>
        <ArtifactVersionsButton workspaceId="s1" paneId="p1" filePath={FILE} />
        <VersionView workspaceId="s1" paneId="p1" filePath={FILE} />
      </>,
    )
    await userEvent.click(screen.getByRole('button', { name: /Versions/ }))
    const rows = await screen.findAllByRole('menuitem', { name: /plan\.md · / })
    expect(rows).toHaveLength(4)
    expect(rows[0]).toHaveTextContent('current')
    await userEvent.click(rows[1])
    const bar = await screen.findByTestId('version-bar')
    expect(bar).toHaveTextContent('Version from')
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Compare with latest' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: `Plan from ${VERSIONS[1].id}` })).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Back to latest' }))
    expect(screen.queryByTestId('version-bar')).not.toBeInTheDocument()
    expect(useArtifactVersionsStore.getState().byPane.p1).toBeUndefined()
  })

  it('writes version times and sizes in the locale setting', async () => {
    useSettingsStore.setState({ locale: 'zh-Hant' })
    await load(1000)
    await renderSettled(<ArtifactVersionsButton workspaceId="s1" paneId="p1" filePath={FILE} />)
    await userEvent.click(screen.getByRole('button', { name: /Versions/ }))
    const rows = await screen.findAllByRole('menuitem', { name: /plan\.md · / })
    expect(rows[0]).toHaveAccessibleName('plan.md · 2026/10/14\u2009下午12:04:00')
    expect(rows[0]).toHaveTextContent(/2026\/10\/14\s下午12:04:00/)
    expect(rows[0]).toHaveTextContent('400 byte')
  })

  it('PRT-C47 goes back to the latest when the file changes on disk', async () => {
    await load(1000)
    await renderSettled(<VersionView workspaceId="s1" paneId="p1" filePath={FILE} />)
    await act(() => useArtifactVersionsStore.getState().show('s1', 'p1', FILE, VERSIONS[2]))
    expect(await screen.findByTestId('version-bar')).toBeInTheDocument()
    await load(2000)
    await waitFor(() => expect(screen.queryByTestId('version-bar')).not.toBeInTheDocument())
  })

  it('PRT-C51 compares a version with the current file in the diff surface', async () => {
    await load(1000)
    vi.mocked(window.ostia.fs.read).mockResolvedValue({
      ok: true,
      text: '# Plan now\n',
      version: 'v',
    })
    const openDiff = vi.spyOn(useLayoutStore.getState(), 'openDiff').mockReturnValue('d1')
    await renderSettled(<VersionView workspaceId="s1" paneId="p1" filePath={FILE} />)
    await act(() => useArtifactVersionsStore.getState().show('s1', 'p1', FILE, VERSIONS[3]))
    await userEvent.click(await screen.findByRole('button', { name: 'Compare with latest' }))
    await waitFor(() => expect(openDiff).toHaveBeenCalledTimes(1))
    expect(openDiff).toHaveBeenCalledWith('s1', {
      title: expect.stringContaining('plan.md'),
      original: `# Plan from ${VERSIONS[3].id}`,
      modified: '# Plan now\n',
      path: FILE,
    })
  })

  it('PRT-C78 offers no Send Error to Agent for an old version that runs', async () => {
    await load(1000)
    let emit: (event: PreviewEvent) => void = () => {}
    vi.mocked(window.ostia.preview.onEvent).mockImplementation((cb) => {
      emit = cb
      return () => {}
    })
    vi.mocked(window.ostia.preview.open).mockResolvedValue({
      id: 'v1',
      partition: 'ostia-preview-v',
      url: 'ostia-preview://v1/',
    })
    vi.mocked(window.ostia.artifacts.version).mockResolvedValue({
      file: `${HISTORY}/${VERSIONS[1].id}`,
      type: 'component',
      sources: { 'plan.md': 'x' },
    })
    await renderSettled(<VersionView workspaceId="s1" paneId="p1" filePath={FILE} />)
    await act(() => useArtifactVersionsStore.getState().show('s1', 'p1', FILE, VERSIONS[1]))
    await waitFor(() => expect(document.querySelector('webview')).not.toBeNull())
    await act(async () =>
      emit({ id: 'v1', type: 'error', error: { kind: 'error', message: 'boom' } }),
    )
    expect(screen.getByTestId('preview-errors')).toHaveTextContent('boom')
    expect(screen.queryByRole('button', { name: 'Send Error to Agent' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Capture region' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Copy errors' })).toBeInTheDocument()
  })
})
