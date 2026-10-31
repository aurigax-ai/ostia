import { beforeEach, describe, expect, it, vi } from 'vitest'

const guests = new Map<number, { isDestroyed: () => boolean }>()
const panes = new Map<string, { windowId: string }>()

vi.mock('electron', () => ({
  webContents: { fromId: (id: number) => guests.get(id) ?? null },
}))
vi.mock('../control/idRegistry', () => ({
  getByPaneId: (paneId: string) => panes.get(paneId),
  resolveExternal: vi.fn(),
}))

const { captureGuestOf } = await import('./browseGuests')

describe('captureGuestOf', () => {
  const browser = { isDestroyed: () => false }
  const preview = { isDestroyed: () => false }
  const previewGuestId = vi.fn((windowId: string, paneId: string) =>
    windowId === '1' && paneId === 'editor-1' ? 20 : null,
  )

  beforeEach(() => {
    guests.clear()
    panes.clear()
    guests.set(10, browser)
    guests.set(20, preview)
    panes.set('browser-1', { windowId: '1' })
    panes.set('editor-1', { windowId: '1' })
  })

  it('finds a browser pane guest only for the window that owns the pane', () => {
    const guestOf = captureGuestOf(new Map([['browser-1', 10]]), previewGuestId)
    expect(guestOf('browser-1', '1')).toBe(browser)
    expect(guestOf('browser-1', '2')).toBeNull()
  })

  it('finds a preview guest only through the preview host, for its own window', () => {
    const guestOf = captureGuestOf(new Map(), previewGuestId)
    expect(guestOf('editor-1', '1')).toBe(preview)
    expect(guestOf('editor-1', '2')).toBeNull()
    expect(guestOf('other', '1')).toBeNull()
  })

  it('never puts a preview guest where an agent can find it', () => {
    const agentPanes = new Map<string, number>()
    captureGuestOf(agentPanes, previewGuestId)('editor-1', '1')
    expect(agentPanes.size).toBe(0)
  })
})
