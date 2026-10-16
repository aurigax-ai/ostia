import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { type FirstLoadGuest, holdFirstLoad } from './guestFirstLoad'

const PAGE = 'https://example.com/restored'

function setup(referrers: Record<string, string> = {}) {
  let release: () => void = () => {}
  let refuse: (reason: Error) => void = () => {}
  const ready = new Promise<void>((ok, fail) => {
    release = ok
    refuse = fail
  })
  const deferred: (() => void)[] = []
  const state = { destroyed: false }
  const guest = Object.assign(new EventEmitter(), {
    isDestroyed: () => state.destroyed,
    stop: vi.fn(),
    loadURL: vi.fn(async () => {}),
  })
  holdFirstLoad(
    guest as unknown as FirstLoadGuest,
    ready,
    (url) => referrers[url],
    (run) => deferred.push(run),
  )
  return {
    guest,
    state,
    release,
    refuse,
    start: (url: string, extra: object = {}) =>
      guest.emit('did-start-navigation', {
        url,
        isMainFrame: true,
        isSameDocument: false,
        ...extra,
      }),
    runDeferred: () => {
      for (const run of deferred.splice(0)) run()
    },
    settle: () => new Promise((ok) => setImmediate(ok)),
  }
}

describe('holdFirstLoad', () => {
  it('stops the first load and starts it again once the page scripts are registered', async () => {
    const { guest, start, runDeferred, release, settle } = setup()
    start(PAGE)
    expect(guest.stop).not.toHaveBeenCalled()
    runDeferred()
    expect(guest.stop).toHaveBeenCalledTimes(1)
    await settle()
    expect(guest.loadURL).not.toHaveBeenCalled()
    release()
    await settle()
    expect(guest.loadURL).toHaveBeenCalledTimes(1)
    expect(guest.loadURL).toHaveBeenCalledWith(PAGE, {})
  })

  it('starts the first load again with the referrer it was opened with', async () => {
    const { guest, start, runDeferred, release, settle } = setup({
      [PAGE]: 'https://site.example/',
    })
    start(PAGE)
    runDeferred()
    release()
    await settle()
    expect(guest.loadURL).toHaveBeenCalledWith(PAGE, { httpReferrer: 'https://site.example/' })
  })

  it('holds only the first load', async () => {
    const { guest, start, runDeferred, release, settle } = setup()
    start(PAGE)
    runDeferred()
    release()
    await settle()
    start('https://example.com/next')
    runDeferred()
    await settle()
    expect(guest.stop).toHaveBeenCalledTimes(1)
    expect(guest.loadURL).toHaveBeenCalledTimes(1)
  })

  it('leaves a load alone that starts after the scripts are registered', async () => {
    const { guest, start, runDeferred, release, settle } = setup()
    release()
    await settle()
    start(PAGE)
    runDeferred()
    await settle()
    expect(guest.stop).not.toHaveBeenCalled()
    expect(guest.loadURL).not.toHaveBeenCalled()
  })

  it('does not bring the held page back over a navigation that started meanwhile', async () => {
    const { guest, start, runDeferred, release, settle } = setup()
    start(PAGE)
    runDeferred()
    start('https://example.com/typed')
    release()
    await settle()
    expect(guest.loadURL).not.toHaveBeenCalled()
  })

  it('ignores subframes and same-document navigations', async () => {
    const { guest, start, runDeferred, release, settle } = setup()
    start('https://example.com/frame', { isMainFrame: false })
    start(`${PAGE}#part`, { isSameDocument: true })
    runDeferred()
    expect(guest.stop).not.toHaveBeenCalled()
    start(PAGE)
    runDeferred()
    start('https://example.com/frame', { isMainFrame: false })
    release()
    await settle()
    expect(guest.loadURL).toHaveBeenCalledWith(PAGE, {})
  })

  it('loads the page even when registering the scripts failed', async () => {
    const { guest, start, runDeferred, refuse, settle } = setup()
    start(PAGE)
    runDeferred()
    refuse(new Error('detached'))
    await settle()
    expect(guest.loadURL).toHaveBeenCalledWith(PAGE, {})
  })

  it('touches nothing on a guest that is gone', async () => {
    const { guest, state, start, runDeferred, release, settle } = setup()
    start(PAGE)
    state.destroyed = true
    runDeferred()
    release()
    await settle()
    expect(guest.stop).not.toHaveBeenCalled()
    expect(guest.loadURL).not.toHaveBeenCalled()
  })
})
