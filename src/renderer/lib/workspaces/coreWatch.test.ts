import { afterEach, describe, expect, it, vi } from 'vitest'
import { resetCoreWatch, watchWorkspace, watchedWorkspaces } from './coreWatch'

const settle = (): Promise<void> => new Promise((r) => queueMicrotask(r))

afterEach(() => {
  resetCoreWatch()
  vi.mocked(window.ostia.git.watch).mockClear()
  vi.mocked(window.ostia.ports.watch).mockClear()
})

describe('watchWorkspace', () => {
  it('tells main nothing until something on screen shows a workspace', async () => {
    await settle()
    expect(window.ostia.git.watch).not.toHaveBeenCalled()
    expect(window.ostia.ports.watch).not.toHaveBeenCalled()
  })

  it('sends one sorted set for several items mounted in the same tick', async () => {
    watchWorkspace('git', 'w2')
    watchWorkspace('git', 'w1')
    watchWorkspace('git', 'w1')
    await settle()
    expect(window.ostia.git.watch).toHaveBeenCalledTimes(1)
    expect(window.ostia.git.watch).toHaveBeenCalledWith(['w1', 'w2'])
    expect(window.ostia.ports.watch).not.toHaveBeenCalled()
  })

  it('keeps a workspace while another item still shows it, and sends an empty set after the last', async () => {
    const first = watchWorkspace('ports', 'w1')
    const second = watchWorkspace('ports', 'w1')
    await settle()
    first()
    await settle()
    expect(watchedWorkspaces('ports')).toEqual(['w1'])
    expect(window.ostia.ports.watch).toHaveBeenCalledTimes(1)
    second()
    second()
    await settle()
    expect(window.ostia.ports.watch).toHaveBeenLastCalledWith([])
  })
})
