import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import type { ApprovalAnswer } from '../lib/chatToolPermissions'
import { decideTool } from '../lib/chatToolPermissions'
import {
  type PendingApproval,
  requestApproval,
  resetChatTools,
  useChatToolsStore,
} from '../stores/chatToolsStore'
import { ChatToolPart, diffLines } from './ChatToolPart'

afterEach(() => {
  cleanup()
  resetChatTools()
})

function ask(request: PendingApproval): Promise<ApprovalAnswer> {
  const access =
    request.kind === 'write' || request.kind === 'command'
      ? 'confirm'
      : request.kind === 'mcp'
        ? 'mcp'
        : 'act'
  return requestApproval(
    request,
    decideTool(request.toolName, access, new Set()),
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
  it('shows a write as a diff with Allow once and Deny only', async () => {
    const answer = ask({
      toolCallId: 't1',
      sessionId: 's1',
      toolName: 'write_file',
      kind: 'write',
      grantable: false,
      input: { path: '/p/a.txt', content: 'one\nTWO\n' },
      detail: { path: '/p/a.txt', exists: true, before: 'one\ntwo\n', after: 'one\nTWO\n' },
    })
    render(<ChatToolPart part={part('write_file')} workspaceId={null} busy />)
    expect(screen.getByText('Write /p/a.txt?')).toBeInTheDocument()
    expect(document.querySelector('[data-diff="del"]')).toHaveTextContent('-two')
    expect(document.querySelector('[data-diff="add"]')).toHaveTextContent('+TWO')
    expect(screen.queryByRole('button', { name: 'Allow for this chat' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Allow once' }))
    expect(await answer).toEqual({ approved: true, scope: 'once' })
    expect(useChatToolsStore.getState().pending).toEqual({})
  })

  it('offers Allow for this chat on an MCP call and records the grant', async () => {
    const answer = ask({
      toolCallId: 't1',
      sessionId: 's1',
      toolName: 'mcp__fake__echo',
      kind: 'mcp',
      grantable: true,
      input: { text: 'hi' },
      detail: { server: 'fake', tool: 'echo' },
    })
    render(<ChatToolPart part={part('mcp__fake__echo')} workspaceId={null} busy />)
    expect(screen.getByText('Call echo on the fake MCP server?')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Allow for this chat' }))
    expect(await answer).toEqual({ approved: true, scope: 'chat' })
    expect(useChatToolsStore.getState().grants.s1).toEqual(['mcp__fake__echo'])
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
    expect(screen.getByRole('button', { name: 'Insert at prompt' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Run in new terminal' }))
    expect(await answer).toEqual({ approved: true, scope: 'once', choice: 'run' })
  })

  it('shows a denied call and a call left waiting after Stop', () => {
    const { rerender } = render(
      <ChatToolPart part={part('write_file', 'output-denied')} workspaceId={null} busy={false} />,
    )
    expect(document.querySelector('.chat-tool')).toHaveAttribute('data-state', 'output-denied')
    expect(screen.getByText('Denied')).toBeInTheDocument()
    rerender(<ChatToolPart part={part('write_file')} workspaceId={null} busy={false} />)
    expect(screen.getByText('Stopped')).toBeInTheDocument()
  })
})

describe('diffLines', () => {
  it('returns nothing for identical text and hunks for changes', () => {
    expect(diffLines('a\n', 'a\n')).toEqual([])
    expect(diffLines('', 'new\n').map((l) => l.kind)).toEqual(['hunk', 'add'])
  })
})
