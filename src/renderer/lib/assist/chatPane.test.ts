import { chatFor, chatKey, startNewSession, useChatStore } from '@/stores/assist/chatStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openChatPane } from './chatPane'

describe('openChatPane', () => {
  const init = {
    chat: useChatStore.getState(),
    layout: useLayoutStore.getState(),
    workspaces: useWorkspacesStore.getState(),
  }

  afterEach(() => {
    useChatStore.setState(init.chat, true)
    useLayoutStore.setState(init.layout, true)
    useWorkspacesStore.setState(init.workspaces, true)
    vi.mocked(window.ostia.diagnostics.report).mockClear()
    vi.restoreAllMocks()
  })

  function seedSession() {
    useWorkspacesStore.getState().addWorkspace('/home/u/api')
    const workspaceId = useWorkspacesStore.getState().activeWorkspaceId as string
    useLayoutStore.getState().ensure(workspaceId)
    return { workspaceId, chat: chatFor(startNewSession(workspaceId)) }
  }

  it('sends the prompt to the workspace’s chat session', async () => {
    const { workspaceId, chat } = seedSession()
    const send = vi.spyOn(chat, 'sendMessage').mockResolvedValue(undefined)

    openChatPane({ workspaceId, prompt: ' why does it fail ', send: true })

    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ text: 'why does it fail' })),
    )
    expect(useChatStore.getState().drafts[chatKey(workspaceId)]).toBeUndefined()
  })

  it('keeps the prompt as the draft and reports the error when sending fails', async () => {
    const { workspaceId, chat } = seedSession()
    vi.spyOn(chat, 'sendMessage').mockRejectedValue(new Error('send failed'))

    openChatPane({ workspaceId, prompt: 'why does it fail', send: true })

    await vi.waitFor(() =>
      expect(useChatStore.getState().drafts[chatKey(workspaceId)]).toBe('why does it fail'),
    )
    expect(window.ostia.diagnostics.report).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'rejection', message: 'send failed' }),
    )
  })
})
