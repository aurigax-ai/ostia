import { registerBuiltinCommands } from '@/commands/builtins'
import { commands } from '@/commands/registry'
import { allPanes } from '@/layout/tree'
import { registerTerminal } from '@/lib/terminal/terminalHandles'
import { useBlocksStore } from '@/stores/terminal/blocksStore'
import { useWorkflowsStore } from '@/stores/terminal/workflowsStore'
import { useLayoutStore } from '@/stores/workspaces/layoutStore'
import { useWorkspacesStore } from '@/stores/workspaces/workspacesStore'
import type { WorkflowEntry, WorkflowListing } from '@shared/workflows'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkflowPicker } from './WorkflowPicker'

const actions = vi.hoisted(() => ({
  insertCommand: vi.fn().mockReturnValue(true),
  canTypeInto: vi.fn().mockReturnValue(true),
}))

vi.mock('@/lib/terminal/blockActions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/terminal/blockActions')>()),
  ...actions,
}))

function entry(partial: Partial<WorkflowEntry> & Pick<WorkflowEntry, 'name' | 'command'>) {
  return { tags: [], arguments: [], source: 'user', origin: 'x.yaml', ...partial } as WorkflowEntry
}

const CLONE = entry({
  name: 'Clone a repository',
  command: 'git clone {{url}} {{dir}}',
  description: 'Clone into a folder',
  tags: ['git'],
  arguments: [
    { name: 'url', description: 'Repository URL' },
    { name: 'dir', defaultValue: 'src' },
  ],
  origin: 'clone.yaml',
})

const DISK = entry({ name: 'Disk usage', command: 'du -sh .', tags: ['fs'], source: 'workspace' })

const LISTING: WorkflowListing = {
  workflows: [CLONE, DISK],
  problems: [{ source: 'user', origin: 'broken.yaml', error: 'missing command' }],
}

describe('WorkflowPicker', () => {
  let blocksInit: ReturnType<typeof useBlocksStore.getState>
  let layoutInit: ReturnType<typeof useLayoutStore.getState>
  let workspacesInit: ReturnType<typeof useWorkspacesStore.getState>
  let workflowsInit: ReturnType<typeof useWorkflowsStore.getState>
  let paneId: string
  let workspaceId: string
  const writeText = vi.fn().mockResolvedValue(undefined)

  beforeAll(() => {
    if (!commands.has('workflows.search')) registerBuiltinCommands()
    blocksInit = useBlocksStore.getState()
    layoutInit = useLayoutStore.getState()
    workspacesInit = useWorkspacesStore.getState()
    workflowsInit = useWorkflowsStore.getState()
  })

  beforeEach(() => {
    useWorkspacesStore.getState().addWorkspace()
    workspaceId = useWorkspacesStore.getState().activeWorkspaceId ?? ''
    useLayoutStore.getState().ensure(workspaceId)
    const root = useLayoutStore.getState().byWorkspace[workspaceId]?.root
    if (!root) throw new Error('no layout')
    paneId = allPanes(root)[0].id
    vi.mocked(window.ostia.workflows.list).mockResolvedValue(LISTING)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  })

  afterEach(() => {
    cleanup()
    useBlocksStore.setState(blocksInit, true)
    useLayoutStore.setState(layoutInit, true)
    useWorkspacesStore.setState(workspacesInit, true)
    useWorkflowsStore.setState(workflowsInit, true)
    actions.insertCommand.mockClear().mockReturnValue(true)
    actions.canTypeInto.mockClear().mockReturnValue(true)
    writeText.mockClear()
  })

  const openPicker = async (): Promise<void> => {
    render(<WorkflowPicker />)
    await act(async () => {
      await commands.exec('workflows.search')
    })
  }

  it('lists the workflows main found for the active workspace, with unreadable files', async () => {
    await openPicker()

    expect(window.ostia.workflows.list).toHaveBeenCalledWith(workspaceId)
    expect(await screen.findByText('Clone a repository')).toBeInTheDocument()
    expect(screen.getByText('Disk usage')).toBeInTheDocument()
    expect(screen.getByText('Yours · clone.yaml')).toBeInTheDocument()
    expect(screen.getByText('broken.yaml')).toBeInTheDocument()
    expect(screen.getByText('missing command')).toBeInTheDocument()
  })

  it('finds a workflow by tag, description or command text', async () => {
    await openPicker()
    const input = await screen.findByPlaceholderText('Search workflows by name, tag or command…')

    await userEvent.type(input, 'du -sh')
    expect(screen.queryByText('Clone a repository')).not.toBeInTheDocument()
    expect(screen.getByText('Disk usage')).toBeInTheDocument()

    await userEvent.clear(input)
    await userEvent.type(input, 'into a folder')
    expect(screen.getByText('Clone a repository')).toBeInTheDocument()
    expect(screen.queryByText('Disk usage')).not.toBeInTheDocument()

    await userEvent.clear(input)
    await userEvent.type(input, 'fs')
    expect(screen.queryByText('Clone a repository')).not.toBeInTheDocument()
    expect(screen.getByText('Disk usage')).toBeInTheDocument()
  })

  it('fills the arguments and inserts the rendered command without running it', async () => {
    useBlocksStore.getState().promptStart(paneId, { line: 0 }, '/w')
    useBlocksStore.getState().promptEnd(paneId, { line: 0 })
    await openPicker()
    await userEvent.click(await screen.findByText('Clone a repository'))

    const url = await screen.findByLabelText('url')
    const dir = screen.getByLabelText('dir')
    expect(url).toHaveFocus()
    expect(dir).toHaveValue('src')
    expect(screen.getByText('Repository URL')).toBeInTheDocument()

    await userEvent.type(url, 'https://x/y.git')
    await userEvent.tab()
    expect(dir).toHaveFocus()
    const preview = screen.getByLabelText('Command')
    expect(preview).toHaveTextContent('git clone https://x/y.git src')
    expect(preview.querySelectorAll('.workflow-arg')).toHaveLength(2)

    await userEvent.click(screen.getByRole('button', { name: 'Insert' }))

    expect(actions.insertCommand).toHaveBeenCalledWith(paneId, 'git clone https://x/y.git src')
    expect(useWorkflowsStore.getState().pickerOpen).toBe(false)
  })

  it('fills the arguments of a picked workflow and pastes it without running', async () => {
    const real = await vi.importActual<typeof import('@/lib/terminal/blockActions')>(
      '@/lib/terminal/blockActions',
    )
    actions.insertCommand.mockImplementation(real.insertCommand)
    actions.canTypeInto.mockImplementation(real.canTypeInto)
    const term = { paste: vi.fn(), focus: vi.fn() }
    const unregister = registerTerminal(paneId, term as never)
    useBlocksStore.getState().promptStart(paneId, { line: 0 }, '/w')
    useBlocksStore.getState().promptEnd(paneId, { line: 0 })
    await openPicker()
    await userEvent.type(
      await screen.findByPlaceholderText('Search workflows by name, tag or command…'),
      'git',
    )
    await userEvent.click(screen.getByText('Clone a repository'))

    const url = await screen.findByLabelText('url')
    expect(url).toHaveFocus()
    expect(screen.getByLabelText('dir')).toHaveValue('src')
    expect(screen.getByLabelText('Command')).toHaveTextContent('git clone {{url}} src')
    await userEvent.type(url, 'https://x/y.git{Enter}')

    expect(term.paste).toHaveBeenCalledWith('git clone https://x/y.git src')
    expect(window.ostia.pty.write).not.toHaveBeenCalled()
    expect(screen.queryByLabelText('url')).not.toBeInTheDocument()
    unregister()
  })

  it('shows empty arguments as their placeholder in the preview', async () => {
    await openPicker()
    await userEvent.click(await screen.findByText('Clone a repository'))

    expect(await screen.findByLabelText('Command')).toHaveTextContent('git clone {{url}} src')
  })

  it('copies to the clipboard when the pane is not at an idle prompt', async () => {
    actions.canTypeInto.mockReturnValue(false)
    actions.insertCommand.mockReturnValue(false)
    useBlocksStore.getState().promptStart(paneId, { line: 0 }, '/w')
    useBlocksStore.getState().promptEnd(paneId, { line: 0 })
    await openPicker()
    await userEvent.click(await screen.findByText('Clone a repository'))
    expect(
      await screen.findByText(
        'The pane isn’t at an idle prompt, so the command goes to the clipboard.',
      ),
    ).toBeInTheDocument()
    await userEvent.type(screen.getByLabelText('url'), 'u{Enter}')

    await waitFor(() => expect(writeText).toHaveBeenCalledWith('git clone u src'))
  })

  it('labels the form action Copy when the pane is busy', async () => {
    actions.canTypeInto.mockReturnValue(false)
    await openPicker()
    await userEvent.click(await screen.findByText('Clone a repository'))

    expect(await screen.findByRole('button', { name: 'Copy to clipboard' })).toBeInTheDocument()
  })

  it('inserts a workflow without arguments straight away', async () => {
    await openPicker()
    await userEvent.click(await screen.findByText('Disk usage'))

    expect(actions.insertCommand).toHaveBeenCalledWith(paneId, 'du -sh .')
    expect(screen.queryByLabelText('Command')).not.toBeInTheDocument()
  })

  it('goes back to the list when the form is cancelled', async () => {
    await openPicker()
    await userEvent.click(await screen.findByText('Clone a repository'))
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }))

    expect(actions.insertCommand).not.toHaveBeenCalled()
    expect(await screen.findByText('Disk usage')).toBeInTheDocument()
  })

  it('explains how to add workflows when there are none', async () => {
    vi.mocked(window.ostia.workflows.list).mockResolvedValue({ workflows: [], problems: [] })
    await openPicker()

    expect(
      await screen.findByText(
        'No workflows yet. Save a command from a block’s menu or from command history.',
      ),
    ).toBeInTheDocument()
  })
})
