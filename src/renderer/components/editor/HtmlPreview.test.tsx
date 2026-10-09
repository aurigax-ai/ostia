import '@testing-library/jest-dom/vitest'
import { findPane, paneBrowserProfile } from '@/layout/tree'
import { useLayoutStore } from '@/stores/layoutStore'
import { type Workspace, useWorkspacesStore } from '@/stores/workspacesStore'
import type { PreviewEvent, PreviewOpened } from '@shared/artifacts/htmlPreview'
import { act, cleanup, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderSettled } from '../../../../test/render'
import { HtmlPreview } from './HtmlPreview'

const FILE = '/data/artifacts/s1/page.html'

function opened(n: number): PreviewOpened {
  return { id: `load${n}`, partition: 'ostia-preview-nonce', url: `ostia-preview://load${n}/` }
}

let emit: (event: PreviewEvent) => void = () => {}
let opens = 0

function guest(): HTMLElement | null {
  return document.querySelector('webview')
}

async function fire(event: PreviewEvent): Promise<void> {
  await act(async () => emit(event))
}

describe('HtmlPreview', () => {
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  const sendErrors = vi.fn()

  beforeAll(() => {
    workspacesInit = useWorkspacesStore.getState()
    layoutInit = useLayoutStore.getState()
  })

  beforeEach(() => {
    opens = 0
    sendErrors.mockReset()
    vi.mocked(window.ostia.preview.open).mockImplementation(async () => {
      opens += 1
      return opened(opens)
    })
    vi.mocked(window.ostia.preview.onEvent).mockImplementation((cb) => {
      emit = cb
      return () => {}
    })
  })

  afterEach(() => {
    cleanup()
    useWorkspacesStore.setState(workspacesInit, true)
    useLayoutStore.setState(layoutInit, true)
  })

  const preview = (visible = true): JSX.Element => (
    <HtmlPreview
      workspaceId="s1"
      paneId="p1"
      filePath={FILE}
      visible={visible}
      onSendErrors={sendErrors}
    />
  )

  it('asks main for a guest and mounts it on the partition and URL main returned', async () => {
    await renderSettled(preview())
    expect(window.ostia.preview.open).toHaveBeenCalledWith('p1', FILE, {
      dark: false,
      vars: {},
    })
    expect(guest()).toHaveAttribute('src', 'ostia-preview://load1/')
    expect(guest()).toHaveAttribute('partition', 'ostia-preview-nonce')
    expect(guest()).not.toHaveAttribute('preload')
    expect(guest()).not.toHaveAttribute('allowpopups')
    expect(guest()).not.toHaveAttribute('nodeintegration')
  })

  it('opens no guest while hidden, and closes the one it had when it unmounts', async () => {
    const view = await renderSettled(preview(false))
    expect(window.ostia.preview.open).not.toHaveBeenCalled()
    await act(async () => view.rerender(preview(true)))
    expect(guest()).not.toBeNull()
    view.unmount()
    expect(window.ostia.preview.close).toHaveBeenCalledWith('load1')
  })

  it('tells main when the preview is hidden and shown', async () => {
    const view = await renderSettled(preview())
    await act(async () => view.rerender(preview(false)))
    expect(window.ostia.preview.shown).toHaveBeenLastCalledWith('load1', false)
    await act(async () => view.rerender(preview(true)))
    expect(window.ostia.preview.shown).toHaveBeenLastCalledWith('load1', true)
  })

  it('shows no strip without errors, then the count and the newest error', async () => {
    await renderSettled(preview())
    expect(screen.queryByTestId('preview-errors')).toBeNull()
    await fire({
      id: 'load1',
      type: 'error',
      error: { kind: 'error', message: 'Uncaught Error: first', source: 'page.html', line: 4 },
    })
    expect(screen.getByTestId('preview-errors')).toHaveTextContent('1 error')
    await fire({ id: 'load1', type: 'error', error: { kind: 'error', message: 'second' } })
    expect(screen.getByTestId('preview-errors')).toHaveTextContent('2 errors')
    expect(screen.getByTestId('preview-errors')).toHaveTextContent('second')
    expect(screen.queryByTestId('preview-error-list')).toBeNull()
    const toggle = screen.getByTestId('preview-errors').querySelector('.preview-strip-toggle')
    await userEvent.click(toggle as HTMLElement)
    const lines = screen.getByTestId('preview-error-list').querySelectorAll('li')
    expect([...lines].map((li) => li.textContent)).toEqual([
      'Uncaught Error: first (page.html:4)',
      'second',
    ])
  })

  it('words a blocked request as having no network', async () => {
    await renderSettled(preview())
    await fire({ id: 'load1', type: 'error', error: { kind: 'blocked', message: 'example.com' } })
    expect(screen.getByTestId('preview-errors')).toHaveTextContent(
      'This page tried to reach example.com; previews have no network',
    )
  })

  it('shows error text as text, never as markup', async () => {
    await renderSettled(preview())
    await fire({
      id: 'load1',
      type: 'error',
      error: { kind: 'error', message: '<img src=x onerror=alert(1)><b>bold</b>' },
    })
    const strip = screen.getByTestId('preview-errors')
    expect(strip.querySelector('img, b')).toBeNull()
    expect(strip).toHaveTextContent('<img src=x onerror=alert(1)><b>bold</b>')
  })

  it('ignores events of another load', async () => {
    await renderSettled(preview())
    await fire({ id: 'other', type: 'error', error: { kind: 'error', message: 'not mine' } })
    await fire({ id: 'other', type: 'stopped', reason: 'memory' })
    expect(screen.queryByTestId('preview-errors')).toBeNull()
    expect(guest()).not.toBeNull()
  })

  it('clears the strip when the page loads again', async () => {
    await renderSettled(preview())
    await fire({ id: 'load1', type: 'error', error: { kind: 'error', message: 'old' } })
    await fire({ id: 'load1', type: 'loading' })
    expect(screen.queryByTestId('preview-errors')).toBeNull()
  })

  it('sends errors only on the human’s click, as one text with the count', async () => {
    await renderSettled(preview())
    await fire({ id: 'load1', type: 'error', error: { kind: 'error', message: 'boom', line: 2 } })
    await fire({ id: 'load1', type: 'error', error: { kind: 'blocked', message: 'example.com' } })
    expect(sendErrors).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'Send Error to Agent' }))
    expect(sendErrors.mock.calls).toEqual([
      [2, 'boom (line 2)\nThis page tried to reach example.com; previews have no network'],
    ])
  })

  it('offers Stop while the page does not respond, and stops through main', async () => {
    await renderSettled(preview())
    expect(screen.queryByTestId('preview-not-responding')).toBeNull()
    await fire({ id: 'load1', type: 'vitals', responding: false, busy: false })
    expect(screen.getByTestId('preview-not-responding')).toHaveTextContent(
      'This page is not responding.',
    )
    await userEvent.click(screen.getByRole('button', { name: 'Stop' }))
    expect(window.ostia.preview.stop).toHaveBeenCalledWith('load1')
    await fire({ id: 'load1', type: 'vitals', responding: true, busy: false })
    expect(screen.queryByTestId('preview-not-responding')).toBeNull()
  })

  it('offers Stop for a busy page without stopping it', async () => {
    await renderSettled(preview())
    await fire({ id: 'load1', type: 'vitals', responding: true, busy: true })
    expect(screen.getByTestId('preview-busy')).toBeInTheDocument()
    expect(window.ostia.preview.stop).not.toHaveBeenCalled()
    expect(guest()).not.toBeNull()
  })

  it('removes the guest and says why when main stopped it, and Reload starts a new one', async () => {
    await renderSettled(preview())
    await fire({ id: 'load1', type: 'stopped', reason: 'unresponsive' })
    expect(guest()).toBeNull()
    expect(screen.getByTestId('preview-stopped')).toHaveTextContent(
      'Stopped: the page did not respond for 15 seconds.',
    )
    expect(opens).toBe(1)
    await userEvent.click(screen.getByRole('button', { name: 'Reload' }))
    expect(opens).toBe(2)
    expect(guest()).toHaveAttribute('src', 'ostia-preview://load2/')
    expect(screen.queryByTestId('preview-stopped')).toBeNull()
  })

  it('names the memory limit when that stopped the page', async () => {
    await renderSettled(preview())
    await fire({ id: 'load1', type: 'stopped', reason: 'memory' })
    expect(screen.getByTestId('preview-stopped')).toHaveTextContent('more than 512 MiB')
  })

  it('drops a preview destroyed while hidden without a message and loads it again when shown', async () => {
    const view = await renderSettled(preview())
    await act(async () => view.rerender(preview(false)))
    await fire({ id: 'load1', type: 'stopped', reason: 'hidden' })
    expect(guest()).toBeNull()
    expect(screen.queryByTestId('preview-stopped')).toBeNull()
    expect(opens).toBe(1)
    await act(async () => view.rerender(preview(true)))
    expect(opens).toBe(2)
    expect(guest()).toHaveAttribute('src', 'ostia-preview://load2/')
  })

  it('says so when a visible preview lost its place to the four-preview cap', async () => {
    await renderSettled(preview())
    await fire({ id: 'load1', type: 'stopped', reason: 'limit' })
    expect(screen.getByTestId('preview-stopped')).toHaveTextContent('only four previews')
  })

  it('says a file main refused cannot be previewed', async () => {
    vi.mocked(window.ostia.preview.open).mockResolvedValue(null)
    await renderSettled(preview())
    expect(guest()).toBeNull()
    expect(screen.getByTestId('preview-stopped')).toHaveTextContent(
      'This file cannot be previewed.',
    )
  })

  it('shows a clicked link in a bar and opens it only on a click, never on the human’s browser profile', async () => {
    const workspace: Workspace = {
      id: 's1',
      name: 'project',
      kind: 'terminal',
      workDir: '/home/me/project',
      state: 'idle',
    }
    useWorkspacesStore.setState({ workspaces: [workspace], activeWorkspaceId: 's1' })
    useLayoutStore.getState().ensure('s1')
    await renderSettled(preview())
    await fire({ id: 'load1', type: 'link', url: 'https://example.com/docs' })
    expect(screen.getByTestId('preview-link')).toHaveTextContent('https://example.com/docs')
    expect(guest()).toHaveAttribute('src', 'ostia-preview://load1/')
    const before = useLayoutStore.getState().byWorkspace.s1
    expect(findPane(before.root, before.activePaneId)?.kind).toBe('terminal')
    await userEvent.click(screen.getByRole('button', { name: 'Open in Browser Pane' }))
    const after = useLayoutStore.getState().byWorkspace.s1
    const browser = findPane(after.root, after.activePaneId)
    expect(browser).toMatchObject({ kind: 'browser', url: 'https://example.com/docs' })
    expect(browser && paneBrowserProfile(browser)).toBe('isolated')
    expect(screen.queryByTestId('preview-link')).toBeNull()
  })

  it('offers no browser pane for a link that is not http or https', async () => {
    await renderSettled(preview())
    await fire({ id: 'load1', type: 'link', url: 'file:///etc/passwd' })
    expect(screen.getByTestId('preview-link')).toHaveTextContent('file:///etc/passwd')
    expect(screen.queryByRole('button', { name: 'Open in Browser Pane' })).toBeNull()
  })
})
