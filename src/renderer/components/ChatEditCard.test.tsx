import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ApprovalAnswer, WriteAskReason } from '../lib/chatToolPermissions'
import { decideTool } from '../lib/chatToolPermissions'
import {
  type ChatEditRecord,
  requestApproval,
  resetChatTools,
  useChatToolsStore,
} from '../stores/chatToolsStore'
import { useDiffStore } from '../stores/diffStore'
import { useLayoutStore } from '../stores/layoutStore'
import { useWorkspacesStore } from '../stores/workspacesStore'
import { ChatEditCard } from './ChatEditCard'

if (!Element.prototype.getAnimations) {
  Element.prototype.getAnimations = () => []
}

const BEFORE = 'one\ntwo\nthree\n'
const AFTER = 'one\nTWO\nthree\n'
const PATH = '/home/u/proj/src/a.ts'

let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
let layoutInit: ReturnType<typeof useLayoutStore.getState>

beforeAll(() => {
  workspacesInit = useWorkspacesStore.getState()
  layoutInit = useLayoutStore.getState()
})

function seedWorkspace(): void {
  useWorkspacesStore.setState({
    workspaces: [
      { id: 'w1', name: 'proj', kind: 'terminal', workDir: '/home/u/proj', state: 'idle' } as never,
    ],
    activeWorkspaceId: 'w1',
  })
}

afterEach(() => {
  cleanup()
  resetChatTools()
  useWorkspacesStore.setState(workspacesInit, true)
  useLayoutStore.setState(layoutInit, true)
  useDiffStore.setState({ byPane: {} })
  vi.mocked(window.pine.chatTools.undo).mockReset()
})

function part(state: string, extra: Record<string, unknown> = {}) {
  return {
    type: 'dynamic-tool',
    toolName: 'edit_file',
    toolCallId: 'e1',
    state,
    input: { path: 'src/a.ts', edits: [{ old_text: 'two', new_text: 'TWO' }] },
    ...extra,
  }
}

function waiting(reason?: WriteAskReason, exists = true): Promise<ApprovalAnswer> {
  const mode = reason && reason !== 'ask-mode' ? 'write' : 'ask'
  return requestApproval(
    {
      toolCallId: 'e1',
      sessionId: 's1',
      toolName: 'edit_file',
      kind: 'write',
      grantable: false,
      input: {},
      detail: {
        path: PATH,
        exists,
        before: exists ? BEFORE : '',
        after: AFTER,
        ...(reason ? { reason } : {}),
      },
    },
    decideTool({
      name: 'edit_file',
      access: 'write',
      mode,
      grants: new Set(),
      outside: reason === 'outside',
      symlink: reason === 'symlink',
      unsaved: reason === 'unsaved',
    }),
    new AbortController().signal,
  )
}

function applied(patch: Partial<ChatEditRecord> = {}): void {
  useChatToolsStore.getState().recordEdit({
    toolCallId: 'e1',
    sessionId: 's1',
    path: PATH,
    root: '/home/u/proj',
    existed: true,
    before: BEFORE,
    after: AFTER,
    version: 'v-new',
    outside: false,
    symlink: false,
    auto: false,
    state: 'applied',
    ...patch,
  })
}

const card = (): HTMLElement => screen.getByRole('region', { name: 'Edit to src/a.ts' })

describe('ChatEditCard', () => {
  it('shows a pending edit as file, counts and hunks, and applies it only on Accept', async () => {
    seedWorkspace()
    const answer = waiting('ask-mode')
    render(
      <ChatEditCard part={part('approval-requested')} name="edit_file" workspaceId="w1" busy />,
    )
    expect(card()).toHaveAttribute('data-state', 'pending')
    expect(within(card()).getByRole('status')).toHaveTextContent('Waiting for you')
    expect(within(card()).getByText('+1')).toBeInTheDocument()
    expect(within(card()).getByText('-1')).toBeInTheDocument()
    expect(document.querySelector('[data-diff="del"]')).toHaveTextContent('-two')
    expect(document.querySelector('[data-diff="add"]')).toHaveTextContent('+TWO')
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Allow for this chat' })).toBeNull()
    await userEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(await answer).toEqual({ approved: true, scope: 'once' })
  })

  it('rejects with the keyboard alone', async () => {
    seedWorkspace()
    const answer = waiting('ask-mode')
    render(
      <ChatEditCard part={part('approval-requested')} name="edit_file" workspaceId="w1" busy />,
    )
    screen.getByRole('button', { name: 'Reject' }).focus()
    await userEvent.keyboard('{Enter}')
    expect(await answer).toEqual({ approved: false })
  })

  it.each([
    ['outside', 'Outside the workspace folder, so it waits for you in every mode.'],
    ['symlink', 'The path goes through a symlink, so it waits for you in every mode.'],
    ['unsaved', /You have unsaved edits in this file, so it waits for you/],
  ] as const)('says why a %s edit waits in Write mode', (reason, text) => {
    seedWorkspace()
    void waiting(reason).catch(() => undefined)
    render(
      <ChatEditCard part={part('approval-requested')} name="edit_file" workspaceId="w1" busy />,
    )
    expect(within(card()).getByText(text)).toBeInTheDocument()
  })

  it('marks a new file', () => {
    seedWorkspace()
    void waiting('ask-mode', false).catch(() => undefined)
    render(
      <ChatEditCard part={part('approval-requested')} name="write_file" workspaceId="w1" busy />,
    )
    expect(within(card()).getByText('New file')).toBeInTheDocument()
  })

  it('says an accepted edit was applied and one made in Write mode was applied automatically', () => {
    seedWorkspace()
    applied()
    const view = render(
      <ChatEditCard
        part={part('output-available')}
        name="edit_file"
        workspaceId="w1"
        busy={false}
      />,
    )
    expect(card()).toHaveAttribute('data-state', 'applied')
    expect(within(card()).getByRole('status')).toHaveTextContent(/^Applied$/)
    view.unmount()
    applied({ auto: true })
    render(
      <ChatEditCard
        part={part('output-available')}
        name="edit_file"
        workspaceId="w1"
        busy={false}
      />,
    )
    expect(card()).toHaveAttribute('data-state', 'auto')
    expect(within(card()).getByRole('status')).toHaveTextContent('Applied automatically')
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull()
  })

  it('undoes an applied edit through main with what was written and what was there before', async () => {
    seedWorkspace()
    applied({ auto: true })
    vi.mocked(window.pine.chatTools.undo).mockResolvedValue({
      ok: true,
      path: PATH,
      removed: false,
      version: 'v-old',
    })
    render(
      <ChatEditCard
        part={part('output-available')}
        name="edit_file"
        workspaceId="w1"
        busy={false}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    await waitFor(() => expect(card()).toHaveAttribute('data-state', 'undone'))
    expect(window.pine.chatTools.undo).toHaveBeenCalledWith({
      path: PATH,
      root: '/home/u/proj',
      outside: false,
      symlinks: false,
      wrote: 'v-new',
      restore: BEFORE,
    })
    expect(within(card()).getByRole('status')).toHaveTextContent('Undone')
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
  })

  it('says plainly when the file changed after the edit and leaves it applied', async () => {
    seedWorkspace()
    applied()
    vi.mocked(window.pine.chatTools.undo).mockResolvedValue({ ok: false, error: 'changed' })
    render(
      <ChatEditCard
        part={part('output-available')}
        name="edit_file"
        workspaceId="w1"
        busy={false}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Undo' }))
    expect(
      await screen.findByText(
        'Not undone: the file changed after this edit, so it was left as it is.',
      ),
    ).toHaveAttribute('role', 'alert')
    expect(card()).toHaveAttribute('data-state', 'applied')
  })

  it('shows a rejected edit and one that hit a conflict on disk', () => {
    seedWorkspace()
    const view = render(
      <ChatEditCard part={part('output-denied')} name="edit_file" workspaceId="w1" busy={false} />,
    )
    expect(card()).toHaveAttribute('data-state', 'rejected')
    expect(within(card()).getByRole('status')).toHaveTextContent('Rejected')
    expect(screen.queryByRole('button')?.textContent).toBe('src/a.ts')
    view.unmount()
    useChatToolsStore.getState().recordFailure('e1', 'changed')
    render(
      <ChatEditCard
        part={part('output-error', { errorText: 'The file changed on disk' })}
        name="edit_file"
        workspaceId="w1"
        busy={false}
      />,
    )
    expect(card()).toHaveAttribute('data-state', 'failed')
    expect(within(card()).getByRole('status')).toHaveTextContent('Not applied')
    expect(within(card()).getByRole('alert')).toHaveTextContent(
      'The file changed on disk first, so nothing was written.',
    )
  })

  it('keeps the counts of an edit from a reopened chat but offers no undo it cannot do', () => {
    seedWorkspace()
    render(
      <ChatEditCard
        part={part('output-available', {
          output: { path: PATH, created: false, added: 3, removed: 2 },
        })}
        name="edit_file"
        workspaceId="w1"
        busy={false}
      />,
    )
    expect(card()).toHaveAttribute('data-state', 'applied')
    expect(within(card()).getByText('+3')).toBeInTheDocument()
    expect(within(card()).getByText('-2')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Undo' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open diff' })).toBeNull()
  })

  it('opens the change in a diff tab of the workspace', async () => {
    seedWorkspace()
    useLayoutStore.getState().ensure('w1')
    applied()
    render(
      <ChatEditCard
        part={part('output-available')}
        name="edit_file"
        workspaceId="w1"
        busy={false}
      />,
    )
    await userEvent.click(screen.getByRole('button', { name: 'Open diff' }))
    const diffs = Object.values(useDiffStore.getState().byPane)
    expect(diffs).toEqual([
      {
        title: 'a.ts (assistant edit)',
        original: BEFORE,
        modified: AFTER,
        language: 'typescript',
        path: PATH,
      },
    ])
  })

  it('shows a call the chat stopped before it resolved', () => {
    seedWorkspace()
    render(
      <ChatEditCard
        part={part('input-available')}
        name="edit_file"
        workspaceId="w1"
        busy={false}
      />,
    )
    expect(card()).toHaveAttribute('data-state', 'stopped')
  })
})
