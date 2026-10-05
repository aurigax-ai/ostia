import type { LanguageServerInfo } from '@shared/languageServers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useLanguageServersStore } from './languageServersStore'

const initial = useLanguageServersStore.getState()

function server(extra: Partial<LanguageServerInfo> = {}): LanguageServerInfo {
  return {
    key: 'lsp-gopls/gopls',
    extId: 'lsp-gopls',
    extName: 'Go (gopls)',
    serverId: 'gopls',
    name: 'gopls',
    languages: ['go'],
    kind: 'program',
    command: 'gopls',
    enabled: true,
    status: 'idle',
    folders: 0,
    ...extra,
  }
}

afterEach(() => {
  useLanguageServersStore.setState(initial, true)
})

describe('languageServersStore', () => {
  it('loads the list and follows changes from main, subscribing once', async () => {
    let push: (list: LanguageServerInfo[]) => void = () => {}
    vi.mocked(window.ostia.lsp.onServersChanged).mockImplementation((cb) => {
      push = cb
      return () => {}
    })
    vi.mocked(window.ostia.lsp.servers).mockResolvedValue([server()])
    await useLanguageServersStore.getState().load()
    await useLanguageServersStore.getState().load()
    expect(window.ostia.lsp.onServersChanged).toHaveBeenCalledTimes(1)
    expect(useLanguageServersStore.getState().list).toEqual([server()])
    push([server({ status: 'running', folders: 1 })])
    expect(useLanguageServersStore.getState().list[0]).toMatchObject({
      status: 'running',
      folders: 1,
    })
  })

  it('shows what main answers after a switch and after a restart', async () => {
    vi.mocked(window.ostia.lsp.setEnabled).mockResolvedValue([
      server({ enabled: false, status: 'off' }),
    ])
    await useLanguageServersStore.getState().setEnabled('lsp-gopls/gopls', false)
    expect(window.ostia.lsp.setEnabled).toHaveBeenCalledWith('lsp-gopls/gopls', false)
    expect(useLanguageServersStore.getState().list[0].status).toBe('off')

    vi.mocked(window.ostia.lsp.servers).mockResolvedValue([server()])
    await useLanguageServersStore.getState().restart('lsp-gopls/gopls')
    expect(window.ostia.lsp.restart).toHaveBeenCalledWith('lsp-gopls/gopls')
    expect(useLanguageServersStore.getState().list[0].status).toBe('idle')
  })
})
