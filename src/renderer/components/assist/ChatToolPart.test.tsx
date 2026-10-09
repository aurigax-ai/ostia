import '@testing-library/jest-dom/vitest'
import type { ApprovalAnswer } from '@/lib/chatToolPermissions'
import { decideTool } from '@/lib/chatToolPermissions'
import {
  type PendingApproval,
  requestApproval,
  resetChatTools,
  useChatToolsStore,
} from '@/stores/chatToolsStore'
import { useSettingsStore } from '@/stores/settingsStore'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { ChatToolPart } from './ChatToolPart'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

let settingsInit: ReturnType<typeof useSettingsStore.getState>

beforeAll(() => {
  settingsInit = useSettingsStore.getState()
})

afterEach(() => {
  cleanup()
  resetChatTools()
  useSettingsStore.setState(settingsInit, true)
})

function ask(request: PendingApproval): Promise<ApprovalAnswer> {
  const access =
    request.kind === 'write' || request.kind === 'command' || request.kind === 'mcp'
      ? request.kind
      : 'act'
  return requestApproval(
    request,
    decideTool({
      name: request.toolName,
      access,
      mode: 'ask',
      grants: new Set(),
      standing: new Set(),
    }),
    new AbortController().signal,
  )
}

const part = (toolName: string, state = 'approval-requested') => ({
  type: 'dynamic-tool',
  toolName,
  toolCallId: 't1',
  state,
  input: { path: '/p/a.txt' },
})

describe('ChatToolPart', () => {
  const mcpRequest: PendingApproval = {
    toolCallId: 't1',
    sessionId: 's1',
    toolName: 'mcp__fake__echo',
    kind: 'mcp',
    grantable: true,
    input: { text: 'hi' },
    detail: { server: 'fake', tool: 'echo' },
  }

  it('offers Allow once as the main action of a split button on an MCP call', async () => {
    const answer = ask(mcpRequest)
    render(<ChatToolPart part={part('mcp__fake__echo')} workspaceId={null} busy />)
    expect(screen.getByText('Call echo on the fake MCP server?')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Allow for this chat' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(await answer).toEqual({ approved: true, scope: 'once' })
    expect(useChatToolsStore.getState().grants.s1).toEqual([])
    expect(window.ostia.chatTools.grantAlways).not.toHaveBeenCalled()
  })

  it('offers Allow for this chat under the caret and records the grant in memory', async () => {
    const answer = ask(mcpRequest)
    render(<ChatToolPart part={part('mcp__fake__echo')} workspaceId={null} busy />)
    await userEvent.click(screen.getByRole('button', { name: 'More ways to allow' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Allow for this chat' }))
    expect(await answer).toEqual({ approved: true, scope: 'chat' })
    expect(useChatToolsStore.getState().grants.s1).toEqual(['mcp__fake__echo'])
    expect(window.ostia.chatTools.grantAlways).not.toHaveBeenCalled()
  })

  it('offers Always allow this tool under the caret and has main keep the grant', async () => {
    vi.mocked(window.ostia.chatTools.grantAlways).mockClear()
    const answer = ask(mcpRequest)
    render(<ChatToolPart part={part('mcp__fake__echo')} workspaceId={null} busy />)
    await userEvent.click(screen.getByRole('button', { name: 'More ways to allow' }))
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Always allow this tool' }))
    expect(await answer).toEqual({ approved: true, scope: 'always' })
    expect(window.ostia.chatTools.grantAlways).toHaveBeenCalledWith('mcp__fake__echo')
    expect(useChatToolsStore.getState().standing).toEqual(['mcp__fake__echo'])
    expect(useChatToolsStore.getState().grants.s1).toEqual([])
  })

  it('offers no caret on a card that cannot be granted', () => {
    void ask({ ...mcpRequest, toolName: 'open_url', kind: 'act', grantable: false })
    render(<ChatToolPart part={part('open_url')} workspaceId={null} busy />)
    expect(screen.getByRole('button', { name: 'Allow once' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More ways to allow' })).toBeNull()
  })

  it('lets the human insert or run a proposed command, or deny it', async () => {
    const answer = ask({
      toolCallId: 't1',
      sessionId: 's1',
      toolName: 'propose_command',
      kind: 'command',
      grantable: false,
      input: { command: 'ls -la' },
      detail: { command: 'ls -la' },
    })
    render(<ChatToolPart part={part('propose_command')} workspaceId={null} busy />)
    expect(screen.getByText('ls -la')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'More ways to allow' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Allow once' })).toBeNull()
    expect(screen.getByRole('button', { name: 'Insert at prompt' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Run in new terminal' }))
    expect(await answer).toEqual({ approved: true, scope: 'once', choice: 'run' })
  })

  it('confirms a multi-line proposed command even when the human turned paste confirmation off', async () => {
    useSettingsStore.getState().setTerminal({ warnOnRiskyPaste: false })
    const answer = ask({
      toolCallId: 't1',
      sessionId: 's1',
      toolName: 'propose_command',
      kind: 'command',
      grantable: false,
      input: { command: 'cd /tmp\nls' },
      detail: { command: 'cd /tmp\nls' },
    })
    render(<ChatToolPart part={part('propose_command')} workspaceId={null} busy />)
    await userEvent.click(screen.getByRole('button', { name: 'Run in new terminal' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveTextContent('It has 2 lines')
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Paste' }))
    expect(await answer).toEqual({ approved: true, scope: 'once', choice: 'run' })
  })

  it('shows a denied call and a call left waiting after Stop', () => {
    const { rerender } = render(
      <ChatToolPart part={part('open_url', 'output-denied')} workspaceId={null} busy={false} />,
    )
    expect(document.querySelector('.chat-tool')).toHaveAttribute('data-state', 'output-denied')
    expect(screen.getByText('Denied')).toBeInTheDocument()
    rerender(<ChatToolPart part={part('open_url')} workspaceId={null} busy={false} />)
    expect(screen.getByText('Stopped')).toBeInTheDocument()
  })

  it('draws both file tools as an edit card instead of raw input', () => {
    for (const tool of ['write_file', 'edit_file']) {
      const { unmount } = render(
        <ChatToolPart part={part(tool, 'output-denied')} workspaceId={null} busy={false} />,
      )
      expect(document.querySelector('.chat-edit')).toHaveAttribute('data-tool', tool)
      expect(screen.getByRole('status')).toHaveTextContent('Rejected')
      unmount()
    }
  })
})
