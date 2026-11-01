import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ShownChip } from '@/lib/extensions/extensionChips'
import { ChipItem } from './ExtensionChips'

const invoke = vi.fn(async (..._args: unknown[]) => ({ ok: true }))

const chip = { extId: 'ssh', id: 'ports', workspaceId: 'w1', title: 'Remote ports' } as ShownChip

beforeEach(() => {
  invoke.mockClear()
  vi.stubGlobal('ostia', { extensions: { invoke } })
  Object.defineProperty(window, 'ostia', { value: { extensions: { invoke } }, configurable: true })
})
afterEach(() => cleanup())

const forwarded = {
  text: ':3000 → localhost:3000',
  url: 'http://localhost:3000',
  port: { remote: 3000, local: 3000 },
}

describe('a port row in the ports chip', () => {
  it('RPF-C10 reads :3000 → localhost:3000 with copy and a pencil, and :8080 for a port not forwarded', () => {
    render(
      <>
        <ChipItem chip={chip} item={forwarded} />
        <ChipItem chip={chip} item={{ text: ':8080', port: { remote: 8080 } }} />
      </>,
    )
    expect(screen.getByText(':3000 → localhost:3000')).toBeInTheDocument()
    expect(screen.getByText(':8080')).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Edit local port/ })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /Copy/ })).toHaveLength(1)
  })

  it('RPF-C9 saves the new local port through the ssh extension', async () => {
    const user = userEvent.setup()
    render(<ChipItem chip={chip} item={forwarded} />)
    await user.click(screen.getByRole('button', { name: /Edit local port/ }))
    const field = screen.getByLabelText('Local port')
    await user.clear(field)
    await user.type(field, '3100')
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    expect(invoke.mock.calls[0].slice(0, 2)).toEqual(['ssh', 'ports-forward'])
    expect(JSON.parse(invoke.mock.calls[0][3] as string)).toEqual({ remote: 3000, local: 3100 })
  })

  it('RPF-C11 refuses Save for 0, 80, 70000 or text and keeps the forward', async () => {
    const user = userEvent.setup()
    render(<ChipItem chip={chip} item={forwarded} />)
    await user.click(screen.getByRole('button', { name: /Edit local port/ }))
    const field = screen.getByLabelText('Local port')
    for (const bad of ['0', '80', '70000', 'abc']) {
      await user.clear(field)
      await user.type(field, bad)
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()
    }
    expect(invoke).not.toHaveBeenCalled()
  })

  it('RPF-C13 sends no local port when the field is emptied', async () => {
    const user = userEvent.setup()
    render(<ChipItem chip={chip} item={forwarded} />)
    await user.click(screen.getByRole('button', { name: /Edit local port/ }))
    await user.clear(screen.getByLabelText('Local port'))
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    expect(JSON.parse(invoke.mock.calls[0][3] as string)).toEqual({ remote: 3000 })
  })

  it('RPF-C14 forwards a port that is not forwarded when the human saves', async () => {
    const user = userEvent.setup()
    render(<ChipItem chip={chip} item={{ text: ':8080', port: { remote: 8080 } }} />)
    await user.click(screen.getByRole('button', { name: /Edit local port/ }))
    expect(screen.queryByRole('button', { name: 'Stop forwarding' })).toBeNull()
    await user.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    expect(JSON.parse(invoke.mock.calls[0][3] as string)).toEqual({ remote: 8080 })
  })

  it('RPF-C15 stops a forward with Stop', async () => {
    const user = userEvent.setup()
    render(<ChipItem chip={chip} item={forwarded} />)
    await user.click(screen.getByRole('button', { name: /Edit local port/ }))
    await user.click(screen.getByRole('button', { name: 'Stop forwarding' }))
    await waitFor(() => expect(invoke).toHaveBeenCalled())
    expect(invoke.mock.calls[0][1]).toBe('ports-stop')
  })
})
