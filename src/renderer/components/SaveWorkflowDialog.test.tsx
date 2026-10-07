import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { useWorkflowsStore } from '../stores/workflowsStore'
import { SaveWorkflowDialog } from './SaveWorkflowDialog'

describe('SaveWorkflowDialog', () => {
  let init: ReturnType<typeof useWorkflowsStore.getState>

  beforeAll(() => {
    init = useWorkflowsStore.getState()
  })

  afterEach(() => {
    cleanup()
    useWorkflowsStore.setState(init, true)
  })

  const open = (command: string): void => {
    useWorkflowsStore.getState().startSave(command)
    render(<SaveWorkflowDialog />)
  }

  it('renders nothing until a command is being saved', () => {
    render(<SaveWorkflowDialog />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('prefills the name and command from the saved command', async () => {
    open('kubectl logs -f deploy/api')

    expect(await screen.findByLabelText('Name')).toHaveValue('kubectl logs -f deploy/api')
    expect(screen.getByLabelText('Command')).toHaveValue('kubectl logs -f deploy/api')
    expect(screen.getByText('No arguments yet')).toBeInTheDocument()
  })

  it('detects arguments as the user edits the command and saves a Warp-style document', async () => {
    open('kubectl logs -f deploy/api')
    const name = await screen.findByLabelText('Name')
    await userEvent.clear(name)
    await userEvent.type(name, 'Follow logs')
    fireEvent.change(screen.getByLabelText('Command'), {
      target: { value: 'kubectl logs -f deploy/{{app}} -n {{ns}}' },
    })
    await userEvent.type(screen.getByLabelText('Tags'), 'k8s, logs, k8s')

    await userEvent.type(screen.getByLabelText('Default value of app'), 'api')
    await userEvent.type(screen.getByLabelText('Description of ns'), 'Namespace')
    await userEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(window.ostia.workflows.save).toHaveBeenCalledWith({
      name: 'Follow logs',
      command: 'kubectl logs -f deploy/{{app}} -n {{ns}}',
      tags: ['k8s', 'logs'],
      arguments: [
        { name: 'app', default_value: 'api' },
        { name: 'ns', description: 'Namespace' },
      ],
    })
    await waitFor(() => expect(useWorkflowsStore.getState().saveCommand).toBeNull())
  })

  it('keeps the dialog open and shows why saving failed', async () => {
    vi.mocked(window.ostia.workflows.save).mockResolvedValue({ ok: false, error: 'disk full' })
    open('make')
    await userEvent.click(await screen.findByRole('button', { name: 'Save' }))

    expect(await screen.findByRole('alert')).toHaveTextContent('disk full')
    expect(useWorkflowsStore.getState().saveCommand).toBe('make')
  })

  it('refuses to save without a name', async () => {
    open('make')
    await userEvent.clear(await screen.findByLabelText('Name'))

    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
  })
})
