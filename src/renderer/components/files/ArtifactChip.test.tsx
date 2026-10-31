import '@testing-library/jest-dom/vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ArtifactListing } from '@shared/artifacts/artifacts'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAttentionStore } from '@/stores/agents/attentionStore'
import { useUIStore } from '@/stores/app/uiStore'
import { useArtifactsStore } from '@/stores/files/artifactsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { renderSettled } from '../../../../test/render'
import { ArtifactChip } from './ArtifactChip'

const DIR = '/data/artifacts/s1'

function listing(...names: string[]): ArtifactListing {
  return {
    dir: DIR,
    pad: `${DIR}/PAD.md`,
    padModified: null,
    entries: names.map((name, i) => ({
      name,
      path: `${DIR}/${name}`,
      size: 10,
      modified: 1000 - i,
    })),
  }
}

function produced(map: Record<string, string>): void {
  vi.mocked(window.ostia.artifacts.producers).mockResolvedValue(
    Object.fromEntries(Object.entries(map).map(([name, pane]) => [`${DIR}/${name}`, pane])),
  )
}

async function load(value: ArtifactListing): Promise<void> {
  vi.mocked(window.ostia.artifacts.list).mockResolvedValue(value)
  await act(() => useArtifactsStore.getState().refresh('s1'))
}

describe('ArtifactChip', () => {
  let artifactsInit: ReturnType<typeof useArtifactsStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let uiInit: ReturnType<typeof useUIStore.getState>
  let attentionInit: ReturnType<typeof useAttentionStore.getState>

  beforeAll(() => {
    artifactsInit = useArtifactsStore.getState()
    layoutInit = useLayoutStore.getState()
    uiInit = useUIStore.getState()
    attentionInit = useAttentionStore.getState()
  })

  beforeEach(() => {
    vi.spyOn(useLayoutStore.getState(), 'openFile').mockImplementation(() => {})
  })

  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
    useArtifactsStore.setState(artifactsInit, true)
    useLayoutStore.setState(layoutInit, true)
    useUIStore.setState(uiInit, true)
    useAttentionStore.setState(attentionInit, true)
  })

  it('PRT-C59 opens the one artifact of a pane and clears its dot', async () => {
    produced({ 'plan.md': 'p1' })
    await load(listing('plan.md'))
    useArtifactsStore.setState({ unread: { [`${DIR}/plan.md`]: true } })
    await renderSettled(<ArtifactChip workspaceId="s1" paneId="p1" />)
    const chip = screen.getByRole('button', { name: /Artifacts from this pane/ })
    expect(chip).toHaveAccessibleName(/plan\.md/)
    expect(screen.getByTestId('artifact-chip-dot')).toBeInTheDocument()
    await userEvent.click(chip)
    expect(useLayoutStore.getState().openFile).toHaveBeenCalledWith('s1', `${DIR}/plan.md`)
    expect(screen.queryByTestId('artifact-chip-dot')).not.toBeInTheDocument()
  })

  it('PRT-C60 lists three artifacts newest first with the unread one marked, and reveals the rest', async () => {
    produced({ 'c.md': 'p1', 'b.md': 'p1', 'a.md': 'p1', 'other.md': 'p2' })
    await load(listing('c.md', 'b.md', 'a.md', 'other.md'))
    useArtifactsStore.setState({ unread: { [`${DIR}/b.md`]: true } })
    await renderSettled(<ArtifactChip workspaceId="s1" paneId="p1" />)
    expect(screen.getByTestId('artifact-chip-count')).toHaveTextContent('3')
    await userEvent.click(screen.getByRole('button', { name: /Artifacts from this pane/ }))
    const menu = await screen.findByRole('menu')
    const rows = within(menu).getAllByRole('menuitem')
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('c.md'),
      expect.stringContaining('b.md'),
      expect.stringContaining('a.md'),
      'All artifacts',
    ])
    expect(within(rows[1]).getByRole('img', { name: 'New or changed' })).toBeInTheDocument()
    await userEvent.click(rows[2])
    expect(useLayoutStore.getState().openFile).toHaveBeenCalledWith('s1', `${DIR}/a.md`)
    await userEvent.click(screen.getByRole('button', { name: /Artifacts from this pane/ }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'All artifacts' }))
    expect(useUIStore.getState().filesOpen).toBe(true)
  })

  it('PRT-C61 shows no chip for a pane that produced nothing or whose artifacts are gone', async () => {
    produced({ 'gone.md': 'p1' })
    await load(listing('other.md'))
    const empty = await renderSettled(<ArtifactChip workspaceId="s1" paneId="p1" />)
    expect(empty.container).toBeEmptyDOMElement()
    empty.unmount()
    const none = await renderSettled(<ArtifactChip workspaceId="s1" paneId="p9" />)
    expect(none.container).toBeEmptyDOMElement()
  })

  it('PRT-C62 works from the keyboard: Enter opens on the first row, arrows move, Enter opens a row, Escape closes', async () => {
    produced({ 'b.md': 'p1', 'a.md': 'p1' })
    await load(listing('b.md', 'a.md'))
    await renderSettled(<ArtifactChip workspaceId="s1" paneId="p1" />)
    act(() => screen.getByRole('button', { name: /Artifacts from this pane/ }).focus())
    await userEvent.keyboard('{Enter}')
    const menu = await screen.findByRole('menu')
    const rows = within(menu).getAllByRole('menuitem')
    expect(rows[0]).toHaveFocus()
    await userEvent.keyboard('{ArrowDown}')
    expect(rows[1]).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    expect(useLayoutStore.getState().openFile).toHaveBeenCalledWith('s1', `${DIR}/a.md`)
    await userEvent.click(screen.getByRole('button', { name: /Artifacts from this pane/ }))
    await screen.findByRole('menu')
    const reached = vi.fn()
    document.addEventListener('keydown', reached)
    await userEvent.keyboard('{Escape}')
    document.removeEventListener('keydown', reached)
    await waitFor(() => expect(screen.queryByRole('menu')).not.toBeInTheDocument())
    expect(reached).not.toHaveBeenCalled()
  })

  it('PRT-C63 is rendered only by the producing pane’s header', async () => {
    produced({ 'plan.md': 'p1' })
    await load(listing('plan.md'))
    const other = await renderSettled(<ArtifactChip workspaceId="s1" paneId="p2" />)
    expect(other.container).toBeEmptyDOMElement()
    const root = join(process.cwd(), 'src', 'renderer')
    const users = readdirSync(root, { recursive: true })
      .map(String)
      .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
      .filter((file) => /\bArtifactChip\b/.test(readFileSync(join(root, file), 'utf8')))
      .filter((file) => !file.endsWith('ArtifactChip.tsx'))
    expect(users).toEqual([join('components', 'panes', 'Pane.tsx')])
    const pane = readFileSync(join(root, 'components', 'panes', 'Pane.tsx'), 'utf8')
    expect(pane).toMatch(/<ArtifactChip workspaceId=\{workspaceId\} paneId=\{shown\.id\} \/>/)
  })

  it('PRT-C64 shares its unread mark with the Files panel row', async () => {
    produced({ 'plan.md': 'p1' })
    await load(listing('plan.md'))
    useArtifactsStore.setState({ unread: { [`${DIR}/plan.md`]: true } })
    await renderSettled(<ArtifactChip workspaceId="s1" paneId="p1" />)
    expect(screen.getByTestId('artifact-chip-dot')).toBeInTheDocument()
    act(() => useArtifactsStore.getState().markRead(`${DIR}/plan.md`))
    expect(screen.queryByTestId('artifact-chip-dot')).not.toBeInTheDocument()
    act(() => useArtifactsStore.setState({ unread: { [`${DIR}/plan.md`]: true } }))
    await userEvent.click(screen.getByRole('button', { name: /Artifacts from this pane/ }))
    expect(useArtifactsStore.getState().unread[`${DIR}/plan.md`]).toBeUndefined()
  })

  it('PRT-C66 never touches the pane’s attention', async () => {
    const dispatch = vi.spyOn(useAttentionStore.getState(), 'dispatch')
    produced({ 'plan.md': 'p1' })
    await load(listing('plan.md'))
    await renderSettled(<ArtifactChip workspaceId="s1" paneId="p1" />)
    await load({
      ...listing('plan.md'),
      entries: listing('plan.md').entries.map((e) => ({ ...e, modified: 5000 })),
    })
    expect(screen.getByTestId('artifact-chip-dot')).toBeInTheDocument()
    expect(dispatch).not.toHaveBeenCalled()
    expect(useAttentionStore.getState().byPane).toEqual({})
    const source = readFileSync(
      join(process.cwd(), 'src', 'renderer', 'components', 'files', 'ArtifactChip.tsx'),
      'utf8',
    )
    expect(source).not.toMatch(/attention/i)
  })

  it('PRT-C65 builds the new artifact views only from the project’s shadcn components', () => {
    const root = join(process.cwd(), 'src', 'renderer', 'components')
    const views = [
      join('files', 'ArtifactChip.tsx'),
      join('editor', 'ArtifactVersions.tsx'),
      join('editor', 'PortableActions.tsx'),
    ]
    for (const view of views) {
      const text = readFileSync(join(root, view), 'utf8')
      const components = [...text.matchAll(/from '@\/components\/([^']+)'/g)].map((m) => m[1])
      for (const used of components) {
        expect(used, `${view} imports ${used}`).toMatch(/^(ui|common|files|editor|agents|shares)\//)
      }
      expect(text, view).not.toMatch(/focus-visible:|focus-within:|outline-/)
      expect(text, view).not.toMatch(/#[0-9a-fA-F]{3,8}\b|text-\[|font-\[/)
      expect(text, view).not.toMatch(/from 'lucide-react'|<svg/)
    }
    const ui = readdirSync(join(root, 'ui'))
      .filter((file) => !file.endsWith('.test.tsx'))
      .sort()
    expect(ui).toEqual([
      'alert-dialog.tsx',
      'alert.tsx',
      'badge.tsx',
      'button-group.tsx',
      'button.tsx',
      'checkbox.tsx',
      'collapsible.tsx',
      'combobox.tsx',
      'command.tsx',
      'context-menu.tsx',
      'dialog.tsx',
      'empty.tsx',
      'input-group.tsx',
      'input.tsx',
      'item.tsx',
      'kbd.tsx',
      'label.tsx',
      'popover.tsx',
      'progress.tsx',
      'radio-group.tsx',
      'scroll-area.tsx',
      'select.tsx',
      'separator.tsx',
      'switch.tsx',
      'table.tsx',
      'tabs.tsx',
      'textarea.tsx',
      'tooltip.tsx',
    ])
  })
})
