import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type ChatEditRecord, resetChatTools, useChatToolsStore } from '../stores/chatToolsStore'
import { ChatReviewBar } from './ChatReviewBar'

function edit(patch: Partial<ChatEditRecord> & Pick<ChatEditRecord, 'toolCallId'>): ChatEditRecord {
  return {
    sessionId: 's1',
    path: '/proj/a.ts',
    root: '/proj',
    existed: true,
    outside: false,
    symlink: false,
    auto: true,
    state: 'applied',
    version: 'v',
    seq: 1,
    decisions: [null],
    before: 'one\n',
    after: 'ONE\n',
    ...patch,
  }
}

afterEach(() => {
  cleanup()
  resetChatTools()
  vi.mocked(window.pine.chatTools.restore).mockReset()
})

const bar = (): HTMLElement => screen.getByRole('region', { name: 'Edits to review' })

describe('ChatReviewBar', () => {
  it('stays hidden until two edits wait for review', () => {
    useChatToolsStore.getState().recordEdit(edit({ toolCallId: 'e1' }))
    render(<ChatReviewBar sessionId="s1" />)
    expect(screen.queryByRole('region', { name: 'Edits to review' })).toBeNull()
  })

  it('counts edits, files and lines, and steps through the files to their cards', async () => {
    const store = useChatToolsStore.getState()
    store.recordEdit(edit({ toolCallId: 'e1', seq: 1 }))
    store.recordEdit(edit({ toolCallId: 'e2', seq: 2, before: 'a\nb\n', after: 'a\nB\nc\n' }))
    store.recordEdit(edit({ toolCallId: 'e3', seq: 3, path: '/proj/b.ts' }))
    render(
      <>
        <ChatReviewBar sessionId="s1" />
        <section data-edit-call="e1" tabIndex={-1} aria-label="card e1" />
        <section data-edit-call="e3" tabIndex={-1} aria-label="card e3" />
      </>,
    )
    expect(within(bar()).getByText('Edits: 3 · Files: 2')).toBeInTheDocument()
    expect(within(bar()).getByText('+4')).toBeInTheDocument()
    expect(within(bar()).getByText('-3')).toBeInTheDocument()
    expect(within(bar()).getByText('1 of 2: a.ts')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Next file' }))
    expect(within(bar()).getByText('2 of 2: b.ts')).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'card e3' })).toHaveFocus()
    await userEvent.click(screen.getByRole('button', { name: 'Next file' }))
    expect(screen.getByRole('region', { name: 'card e1' })).toHaveFocus()
    await userEvent.click(screen.getByRole('button', { name: 'Previous file' }))
    expect(within(bar()).getByText('2 of 2: b.ts')).toBeInTheDocument()
  })

  it('keeps every edit on Accept all and the bar goes away', async () => {
    const store = useChatToolsStore.getState()
    store.recordEdit(edit({ toolCallId: 'e1', seq: 1 }))
    store.recordEdit(edit({ toolCallId: 'e2', seq: 2, path: '/proj/b.ts' }))
    render(<ChatReviewBar sessionId="s1" />)
    await userEvent.click(within(bar()).getByRole('button', { name: 'Accept all' }))
    expect(screen.queryByRole('region', { name: 'Edits to review' })).toBeNull()
    expect(useChatToolsStore.getState().edits.e2.decisions).toEqual(['accepted'])
  })

  it('undoes every edit on Reject all', async () => {
    const store = useChatToolsStore.getState()
    store.recordEdit(edit({ toolCallId: 'e1', seq: 1 }))
    store.recordEdit(edit({ toolCallId: 'e2', seq: 2, path: '/proj/b.ts' }))
    vi.mocked(window.pine.chatTools.restore).mockResolvedValue({
      ok: true,
      path: '/proj/a.ts',
      removed: false,
      version: 'v-old',
    })
    render(<ChatReviewBar sessionId="s1" />)
    await userEvent.click(within(bar()).getByRole('button', { name: 'Reject all' }))
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Edits to review' })).toBeNull(),
    )
    expect(window.pine.chatTools.restore).toHaveBeenCalledTimes(2)
    expect(useChatToolsStore.getState().edits.e1.state).toBe('undone')
  })
})
