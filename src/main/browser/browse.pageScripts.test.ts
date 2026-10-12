import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn(), on: vi.fn() },
  webContents: { fromId: () => null },
}))
vi.mock('../approvals/controlElevation', () => ({ ensureCaps: vi.fn(async () => {}) }))
vi.mock('../control/controlServer', () => ({ registerTargetableMethod: vi.fn() }))

const { injectPageScripts } = await import('./browse')

type Call = { method: string; params?: object; sessionId?: string }
type Reply = (call: Call) => Promise<unknown>

const AUTO_ATTACH = {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
  filter: [{ type: 'iframe' }],
}

function fakeGuest(reply: Reply = async () => ({})) {
  const events = new EventEmitter()
  const calls: Call[] = []
  const dbg = {
    on: (event: 'message', listener: (event: unknown, method: string, params: unknown) => void) =>
      events.on(event, listener),
    sendCommand: (method: string, params?: object, sessionId?: string) => {
      const call: Call = { method, params }
      if (sessionId !== undefined) call.sessionId = sessionId
      calls.push(call)
      return reply(call)
    },
  }
  const attach = (sessionId: string, type: string, parent?: string) =>
    events.emit(
      'message',
      {},
      'Target.attachedToTarget',
      { sessionId, targetInfo: { type }, waitingForDebugger: true },
      parent,
    )
  return { guest: { debugger: dbg }, events, calls, attach }
}

function prepared(sessionId?: string, sources = ['A', 'B']): Call[] {
  const on = (call: Call): Call => (sessionId === undefined ? call : { ...call, sessionId })
  return [
    on({ method: 'Page.enable', params: {} }),
    ...sources.map((source) =>
      on({
        method: 'Page.addScriptToEvaluateOnNewDocument',
        params: { source, runImmediately: true },
      }),
    ),
    on({ method: 'Target.setAutoAttach', params: AUTO_ATTACH }),
  ]
}

const resume = (sessionId: string): Call => ({
  method: 'Runtime.runIfWaitingForDebugger',
  params: {},
  sessionId,
})

const settle = () => new Promise((ok) => setTimeout(ok, 0))

describe('injectPageScripts', () => {
  it('registers every script on the main frame and asks to pause new cross-site iframes', () => {
    const { guest, calls } = fakeGuest()
    injectPageScripts(guest, ['A', 'B'])
    expect(calls).toEqual(prepared())
  })

  it('sends the scripts without waiting for Page.enable to answer', () => {
    const { guest, calls } = fakeGuest(({ method }) =>
      method === 'Page.enable' ? new Promise(() => {}) : Promise.resolve({}),
    )
    injectPageScripts(guest, ['A'])
    expect(calls.map((c) => c.method)).toContain('Page.addScriptToEvaluateOnNewDocument')
  })

  it('gives a new cross-site iframe the same scripts on its own session, then resumes it', () => {
    const { guest, calls, attach } = fakeGuest()
    injectPageScripts(guest, ['A', 'B'])
    calls.length = 0
    attach('frame-1', 'iframe')
    expect(calls).toEqual([...prepared('frame-1'), resume('frame-1')])
  })

  it('auto-attaches nested iframes through the child session', () => {
    const { guest, calls, attach } = fakeGuest()
    injectPageScripts(guest, ['A'])
    attach('outer', 'iframe')
    calls.length = 0
    attach('inner', 'iframe', 'outer')
    expect(calls).toEqual([...prepared('inner', ['A']), resume('inner')])
  })

  it('still resumes the iframe when its scripts are rejected', async () => {
    const { guest, calls, attach } = fakeGuest(async ({ method, sessionId }) => {
      if (sessionId && method !== 'Runtime.runIfWaitingForDebugger') throw new Error('boom')
      return {}
    })
    injectPageScripts(guest, ['A'])
    attach('frame-1', 'iframe')
    await settle()
    expect(calls.at(-1)).toEqual(resume('frame-1'))
  })

  it('still resumes the iframe when sending a script throws', () => {
    const { guest, calls, attach } = fakeGuest(({ method, sessionId }) => {
      if (sessionId && method === 'Page.addScriptToEvaluateOnNewDocument') {
        throw new Error('not attached')
      }
      return Promise.resolve({})
    })
    injectPageScripts(guest, ['A'])
    attach('frame-1', 'iframe')
    expect(calls.at(-1)).toEqual(resume('frame-1'))
  })

  it('stays quiet when the iframe target is already gone', async () => {
    const { guest, calls, attach } = fakeGuest(async ({ sessionId }) => {
      if (sessionId) throw new Error(`No session with given id: ${sessionId}`)
      return {}
    })
    injectPageScripts(guest, ['A'])
    expect(() => attach('gone', 'iframe')).not.toThrow()
    await settle()
    expect(calls.filter((c) => c.sessionId === 'gone').map((c) => c.method)).toEqual([
      'Page.enable',
      'Page.addScriptToEvaluateOnNewDocument',
      'Target.setAutoAttach',
      'Runtime.runIfWaitingForDebugger',
    ])
  })

  it('only resumes a target that is not an iframe', () => {
    const { guest, calls, attach } = fakeGuest()
    injectPageScripts(guest, ['A'])
    calls.length = 0
    attach('worker-1', 'worker')
    expect(calls).toEqual([resume('worker-1')])
  })

  it('ignores other events and attaches without a session id', () => {
    const { guest, calls, events } = fakeGuest()
    injectPageScripts(guest, ['A'])
    calls.length = 0
    events.emit('message', {}, 'Page.frameNavigated', { frame: {} })
    events.emit('message', {}, 'Target.attachedToTarget', { targetInfo: { type: 'iframe' } })
    events.emit('message', {}, 'Target.attachedToTarget', undefined)
    expect(calls).toEqual([])
  })

  it('handles each iframe once after the debugger is attached again', () => {
    const { guest, calls, attach } = fakeGuest()
    injectPageScripts(guest, ['A'])
    injectPageScripts(guest, ['A'])
    expect(calls).toEqual([...prepared(undefined, ['A']), ...prepared(undefined, ['A'])])
    calls.length = 0
    attach('frame-1', 'iframe')
    expect(calls).toEqual([...prepared('frame-1', ['A']), resume('frame-1')])
  })
})
