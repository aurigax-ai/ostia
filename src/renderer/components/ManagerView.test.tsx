import '@testing-library/jest-dom/vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const terms: FakeXterm[] = []

class FakeXterm {
  options: Record<string, unknown>
  written: string[] = []
  size: [number, number] = [80, 24]
  constructor(options: Record<string, unknown>) {
    this.options = options
    terms.push(this)
  }
  open(): void {}
  write(data: string): void {
    this.written.push(data)
  }
  resize(cols: number, rows: number): void {
    this.size = [cols, rows]
  }
  dispose(): void {}
}

vi.mock('@xterm/xterm', () => ({ Terminal: FakeXterm }))

const { ManagerView } = await import('./ManagerView')

const pty = () => vi.mocked(window.pine.pty)

function handler<T extends (...args: never[]) => unknown>(mock: unknown): T {
  const call = vi.mocked(mock as (...a: unknown[]) => unknown).mock.calls.at(-1)
  return call?.[1] as T
}

describe('ManagerView', () => {
  afterEach(() => {
    cleanup()
    terms.length = 0
    vi.clearAllMocks()
  })

  it('MGR-C20 attaches as a read-only observer that never spawns, types or resizes', async () => {
    pty().attach.mockResolvedValueOnce({
      created: false,
      buffer: 'hello',
      cursor: 5,
      dropped: false,
      cols: 132,
      rows: 40,
    })
    render(<ManagerView paneId="p9" />)
    await act(async () => {})

    expect(pty().attach).toHaveBeenCalledWith('p9', {
      cols: 0,
      rows: 0,
      role: 'observer',
      attachOnly: true,
    })
    const term = terms[0]
    expect(term?.options.disableStdin).toBe(true)
    expect(term?.size).toEqual([132, 40])
    expect(term?.written).toEqual(['hello'])
    expect(pty().write).not.toHaveBeenCalled()
    expect(pty().resize).not.toHaveBeenCalled()
    expect(screen.getByText(/Read-only/)).toBeInTheDocument()
  })

  it('MGR-C21 follows the size the mirror sets', async () => {
    pty().attach.mockResolvedValueOnce({
      created: false,
      buffer: '',
      cursor: 0,
      dropped: false,
      cols: 80,
      rows: 24,
    })
    render(<ManagerView paneId="p9" />)
    await act(async () => {})
    act(() => handler<(c: number, r: number) => void>(pty().onSize)(100, 30))
    expect(terms[0]?.size).toEqual([100, 30])
    expect(pty().resize).not.toHaveBeenCalled()
  })

  it('MGR-C23 shows that the manager ended when there is nothing to attach to', async () => {
    pty().attach.mockResolvedValueOnce({ created: false, buffer: '', cursor: 0, dropped: false })
    render(<ManagerView paneId="gone" />)
    await act(async () => {})
    expect(screen.getByText('The manager has ended.')).toBeInTheDocument()
  })
})
