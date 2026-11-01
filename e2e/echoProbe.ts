import type { ElectronApplication, Page } from './test'

interface Stamp {
  t: number
}

export interface MainProbe {
  writes: (Stamp & { paneId: string })[]
  recv: (Stamp & { pid: number })[]
  flush: (Stamp & { pid: number })[]
  send: (Stamp & { channel: string })[]
  spawns: number[]
  lag: number[]
}

export interface PageProbe {
  keys: Stamp[]
  inputs: Stamp[]
  arrivals: Stamp[]
  writeDone: Stamp[]
  renders: Stamp[]
  frameEnds: Stamp[]
}

export function installMainProbe({ app, ipcMain, BrowserWindow }: typeof import('electron')): void {
  const now = () => performance.timeOrigin + performance.now()
  const probe: MainProbe = {
    writes: [],
    recv: [],
    flush: [],
    send: [],
    spawns: [],
    lag: [],
  }
  ;(globalThis as unknown as { __echoMain: MainProbe }).__echoMain = probe
  const { createRequire } = (process.mainModule as NodeJS.Module).require(
    'node:module',
  ) as typeof import('node:module')
  const load = createRequire(`${app.getAppPath()}/package.json`)

  ipcMain.prependListener('pty:write', (_e, paneId: string) =>
    probe.writes.push({ t: now(), paneId }),
  )

  const nodePty = load('node-pty') as typeof import('node-pty')
  const spawn = nodePty.spawn
  nodePty.spawn = (...args: Parameters<typeof spawn>) => {
    const proc = spawn(...args)
    probe.spawns.push(proc.pid)
    proc.onData(() => {
      probe.recv.push({ t: now(), pid: proc.pid })
      setImmediate(() => probe.flush.push({ t: now(), pid: proc.pid }))
    })
    return proc
  }

  const contents = BrowserWindow.getAllWindows()[0].webContents
  const send = contents.send.bind(contents)
  contents.send = (channel: string, ...args: unknown[]) => {
    if (channel.startsWith('pty:data:')) probe.send.push({ t: now(), channel })
    send(channel, ...args)
  }

  let last = performance.now()
  setInterval(() => {
    const at = performance.now()
    probe.lag.push(Math.max(0, at - last - 5))
    last = at
  }, 5)
}

export interface TerminalHandle {
  attachCustomKeyEventHandler?: unknown
  write: (data: string, cb?: () => void) => void
  onData: (cb: () => void) => unknown
  onRender: (cb: () => void) => unknown
  onScroll: (cb: () => void) => unknown
  scrollLines: (amount: number) => void
  buffer: { active: { viewportY: number; baseY: number } }
}

export function hookTerminal({
  paneId,
  frameAfterWrite,
}: {
  paneId: string
  frameAfterWrite: boolean
}): void {
  const now = () => performance.timeOrigin + performance.now()
  const probe: PageProbe = {
    keys: [],
    inputs: [],
    arrivals: [],
    writeDone: [],
    renders: [],
    frameEnds: [],
  }
  ;(window as unknown as { __echo: PageProbe }).__echo = probe
  const lookup = (): TerminalHandle => {
    const surface = document.querySelector(`.pane[data-pane-id="${paneId}"] .terminal-surface`)
    if (!surface) throw new Error(`no terminal surface for pane ${paneId}`)
    const fiberKey = Object.keys(surface).find((k) => k.startsWith('__reactFiber$'))
    type Fiber = { memoizedState: HookLike | null; return: Fiber | null }
    type HookLike = { memoizedState: unknown; next: HookLike | null }
    let fiber = fiberKey ? ((surface as unknown as Record<string, Fiber>)[fiberKey] ?? null) : null
    while (fiber) {
      for (let hook = fiber.memoizedState; hook; hook = hook.next) {
        const ref = hook.memoizedState as { current?: TerminalHandle } | null
        const held = ref && typeof ref === 'object' ? ref.current : undefined
        if (held && typeof held.attachCustomKeyEventHandler === 'function') return held
      }
      fiber = fiber.return
    }
    throw new Error(`no terminal handle for pane ${paneId}`)
  }
  const term = lookup()
  ;(window as unknown as { __term: TerminalHandle }).__term = term
  window.addEventListener('keydown', () => probe.keys.push({ t: now() }), true)
  term.onData(() => probe.inputs.push({ t: now() }))
  const write = term.write.bind(term)
  term.write = (data, cb) => {
    probe.arrivals.push({ t: now() })
    write(data, () => {
      probe.writeDone.push({ t: now() })
      if (frameAfterWrite) {
        requestAnimationFrame(() => {
          probe.renders.push({ t: now() })
          channel.port2.postMessage(0)
        })
      }
      cb?.()
    })
  }
  const channel = new MessageChannel()
  channel.port1.onmessage = () => probe.frameEnds.push({ t: now() })
  if (!frameAfterWrite) {
    term.onRender(() => {
      probe.renders.push({ t: now() })
      channel.port2.postMessage(0)
    })
  }
}

export function startMainProfile(): void {
  const inspector = (process.mainModule as NodeJS.Module).require(
    'node:inspector',
  ) as typeof import('node:inspector')
  const session = new inspector.Session()
  session.connect()
  session.post('Profiler.enable')
  session.post('Profiler.start')
  ;(globalThis as unknown as { __echoSession: unknown }).__echoSession = session
}

export function stopMainProfile(): Promise<string[]> {
  const session = (globalThis as unknown as { __echoSession: import('node:inspector').Session })
    .__echoSession
  return new Promise((resolve) => {
    session.post('Profiler.stop', (_err, result) => {
      const profile = result.profile
      const byId = new Map(profile.nodes.map((n) => [n.id, n]))
      const self = new Map<string, number>()
      profile.samples?.forEach((id, i) => {
        const frame = byId.get(id)?.callFrame
        if (!frame) return
        const file = frame.url.split('/').pop() ?? ''
        const key = `${frame.functionName || '(anon)'} ${file}:${frame.lineNumber}`
        self.set(key, (self.get(key) ?? 0) + (profile.timeDeltas?.[i] ?? 0) / 1000)
      })
      resolve(
        [...self.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 12)
          .map(([key, ms]) => `${Math.round(ms)}ms ${key}`),
      )
    })
  })
}

export async function readProbes(
  app: ElectronApplication,
  win: Page,
): Promise<{ main: MainProbe; page: PageProbe }> {
  const main = await app.evaluate(
    () => (globalThis as unknown as { __echoMain: MainProbe }).__echoMain,
  )
  const page = await win.evaluate(() => (window as unknown as { __echo: PageProbe }).__echo)
  return { main, page }
}

const STEPS = [
  'keyHandling',
  'ipcToMain',
  'shellEcho',
  'mainFeed',
  'mainFlush',
  'ipcToRenderer',
  'engineWrite',
  'renderWait',
  'frameEnd',
  'total',
] as const

type StepName = (typeof STEPS)[number]

export interface KeyTimeline extends Record<StepName, number> {
}

function after<T extends Stamp>(
  list: T[],
  t: number,
  limit: number,
  accept: (v: T) => boolean,
): T | undefined {
  return list.find((v) => v.t >= t && v.t < limit && accept(v))
}

export function alignKeys(
  main: MainProbe,
  page: PageProbe,
  paneId: string,
  pid: number,
): KeyTimeline[] {
  const timelines: KeyTimeline[] = []
  page.keys.forEach((key, index) => {
    const limit = page.keys[index + 1]?.t ?? Number.POSITIVE_INFINITY
    const write = after(page.inputs, key.t, limit, () => true)
    if (!write) return
    const received = after(main.writes, write.t, limit, (v) => v.paneId === paneId)
    if (!received) return
    const echo = after(main.recv, received.t, limit, (v) => v.pid === pid)
    if (!echo) return
    const flush = after(main.flush, echo.t, limit, (v) => v.pid === pid)
    const sent = after(main.send, echo.t, limit, (v) => v.channel === `pty:data:${paneId}`)
    if (!flush || !sent) return
    const arrived = after(page.arrivals, sent.t, limit, () => true)
    if (!arrived) return
    const written = after(page.writeDone, arrived.t, limit, () => true)
    if (!written) return
    const render = after(page.renders, written.t, limit, () => true)
    if (!render) return
    const frameEnd = after(page.frameEnds, render.t, limit, () => true)
    if (!frameEnd) return
    timelines.push({
      keyHandling: write.t - key.t,
      ipcToMain: received.t - write.t,
      shellEcho: echo.t - received.t,
      mainFeed: flush.t - echo.t,
      mainFlush: sent.t - flush.t,
      ipcToRenderer: arrived.t - sent.t,
      engineWrite: written.t - arrived.t,
      renderWait: render.t - written.t,
      frameEnd: frameEnd.t - render.t,
      total: frameEnd.t - key.t,
    })
  })
  return timelines
}

export function percentile(values: number[], q: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const value = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
  return Math.round(value * 10) / 10
}

export function summarize(timelines: KeyTimeline[]): Record<string, [number, number]> {
  const names = STEPS
  return Object.fromEntries(
    names.map((name) => {
      const values = timelines.map((t) => t[name])
      return [name, [percentile(values, 0.5), percentile(values, 0.95)]]
    }),
  )
}
