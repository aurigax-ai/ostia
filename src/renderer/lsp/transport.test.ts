import { describe, expect, it, vi } from 'vitest'
import type { Message } from 'vscode-jsonrpc'
import { IpcReader, IpcWriter } from './transport'

const fixture = { jsonrpc: '2.0', method: 'initialize' } as Message

describe('IpcReader', () => {
  it('subscribes to onMessage with its id when listen is called', () => {
    const reader = new IpcReader('srv-1')
    reader.listen(() => {})
    expect(window.pine.lsp.onMessage).toHaveBeenCalledWith('srv-1', expect.any(Function))
  })

  it('forwards an inbound message to the DataCallback passed to listen', () => {
    let captured: ((m: unknown) => void) | undefined
    const unsub = vi.fn()
    vi.mocked(window.pine.lsp.onMessage).mockImplementation((_id, cb) => {
      captured = cb as (m: unknown) => void
      return unsub
    })
    const cb = vi.fn()
    new IpcReader('srv-1').listen(cb)
    captured?.(fixture)
    expect(cb).toHaveBeenCalledTimes(1)
    expect(cb).toHaveBeenCalledWith(fixture)
  })

  it('disposes by invoking the unsubscribe returned by onMessage exactly once', () => {
    const unsub = vi.fn()
    vi.mocked(window.pine.lsp.onMessage).mockImplementation(() => unsub)
    const disposable = new IpcReader('srv-1').listen(() => {})
    expect(unsub).not.toHaveBeenCalled()
    disposable.dispose()
    expect(unsub).toHaveBeenCalledTimes(1)
  })
})

describe('IpcWriter', () => {
  it('sends a written message to the lsp bridge with its id and resolves', async () => {
    const writer = new IpcWriter('srv-1')
    await expect(writer.write(fixture)).resolves.toBeUndefined()
    expect(window.pine.lsp.send).toHaveBeenCalledWith('srv-1', fixture)
  })

  it('does nothing and does not send when end is called', () => {
    const writer = new IpcWriter('srv-1')
    expect(() => writer.end()).not.toThrow()
    expect(window.pine.lsp.send).not.toHaveBeenCalled()
  })
})
