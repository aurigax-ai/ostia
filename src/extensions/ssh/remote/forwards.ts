import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import {
  FORWARD_MAX,
  type ForwardRow,
  type HostPort,
  LOCAL_PORT_MAX,
  LOCAL_PORT_MIN,
  type PortsResult,
  validLocalPort,
} from '../../../shared/remote/remotePorts'
import type { SpawnSsh } from '../channel'
import { type ConnectPlan, planControlForward, planForward } from '../plan'
import type { PortMap } from './portMap'

const RESTART_MS = 1000

export type ForwardMode = 'auto' | 'manual'

export interface HostForwardsDeps {
  host: string
  plan: ConnectPlan
  spawn: SpawnSsh
  map: PortMap
  mode: () => Promise<ForwardMode>
  isFree: (port: number) => Promise<boolean>
  changed: () => void
}

interface Running {
  remote: number
  local: number
  child: ChildProcessWithoutNullStreams | null
  timer?: ReturnType<typeof setTimeout>
}

export class HostForwards {
  private online = false
  private ports: HostPort[] = []
  private baseline: Set<number> | null = null
  private readonly running = new Map<number, Running>()
  private readonly errors = new Map<number, string>()
  private readonly stopped = new Set<number>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: HostForwardsDeps) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => {})
    return next
  }

  rows(): ForwardRow[] {
    return this.ports.map((p) => {
      const forward = this.running.get(p.port)
      const error = this.errors.get(p.port)
      return {
        remote: p.port,
        ...(p.name ? { name: p.name } : {}),
        ...(forward ? { local: forward.local } : {}),
        ...(error ? { error } : {}),
      }
    })
  }

  onLink(online: boolean): Promise<void> {
    return this.serial(async () => {
      this.online = online
      this.baseline = null
      if (!online) {
        this.ports = []
        for (const forward of this.running.values()) this.release(forward)
        this.running.clear()
        this.errors.clear()
      }
      this.deps.changed()
    })
  }

  onPorts(ports: HostPort[]): Promise<void> {
    return this.serial(async () => {
      if (!this.online) return
      this.ports = ports
      const listed = new Set(ports.map((p) => p.port))
      this.baseline ??= new Set(listed)
      for (const [remote, forward] of [...this.running]) {
        if (listed.has(remote)) continue
        this.release(forward)
        this.running.delete(remote)
      }
      for (const remote of [...this.errors.keys()])
        if (!listed.has(remote)) this.errors.delete(remote)
      for (const remote of [...this.stopped]) if (!listed.has(remote)) this.stopped.delete(remote)
      const saved = this.deps.map.get(this.deps.host)
      for (const { port } of ports) {
        if (this.running.has(port) || this.stopped.has(port) || this.errors.has(port)) continue
        const chosen = saved.get(port)
        if (chosen !== undefined) await this.start(port, chosen, true)
        else if ((await this.deps.mode()) === 'auto' && !this.baseline.has(port)) {
          if (this.running.size >= FORWARD_MAX) continue
          const local = await this.pickLocal(port)
          if (local !== null) await this.start(port, local, false)
        }
      }
      this.deps.changed()
    })
  }

  forward(remote: number, local: number | undefined): Promise<PortsResult> {
    return this.serial(async () => {
      if (!this.online) return { ok: false, error: 'link-down' }
      if (!this.ports.some((p) => p.port === remote)) return { ok: false, error: 'not-listening' }
      if (local !== undefined && !validLocalPort(local)) return { ok: false, error: 'bad-port' }
      const current = this.running.get(remote)
      if (current && local === current.local) return this.answer()
      if (!current && this.running.size >= FORWARD_MAX) return { ok: false, error: 'too-many' }
      let target: number
      if (local === undefined) {
        const picked = await this.pickLocal(remote, current?.local)
        if (picked === null) return { ok: false, error: 'port-taken' }
        target = picked
      } else {
        const inUse = [...this.running].some(([r, f]) => r !== remote && f.local === local)
        if (inUse || !(await this.deps.isFree(local))) return { ok: false, error: 'port-taken' }
        target = local
      }
      if (current) {
        this.release(current)
        this.running.delete(remote)
      }
      this.stopped.delete(remote)
      this.errors.delete(remote)
      await this.start(remote, target, false)
      this.deps.changed()
      return this.answer()
    })
  }

  stop(remote: number): Promise<PortsResult> {
    return this.serial(async () => {
      const current = this.running.get(remote)
      if (current) {
        this.release(current)
        this.running.delete(remote)
      }
      this.errors.delete(remote)
      this.stopped.add(remote)
      this.deps.map.forget(this.deps.host, remote)
      this.deps.changed()
      return this.answer()
    })
  }

  list(): PortsResult {
    return this.answer()
  }

  closeAll(): void {
    for (const forward of this.running.values()) this.release(forward)
    this.running.clear()
    this.online = false
  }

  private answer(): PortsResult {
    return this.online ? { ok: true, forwards: this.rows() } : { ok: false, error: 'link-down' }
  }

  private async pickLocal(remote: number, own?: number): Promise<number | null> {
    const used = new Set(
      [...this.running.values()].filter((f) => f.local !== own).map((f) => f.local),
    )
    for (let port = Math.max(remote, LOCAL_PORT_MIN); port <= LOCAL_PORT_MAX; port++) {
      if (used.has(port)) continue
      if (await this.deps.isFree(port)) return port
    }
    return null
  }

  private async start(remote: number, local: number, restoring: boolean): Promise<void> {
    const inUse = [...this.running.values()].some((f) => f.local === local)
    if (inUse || !(await this.deps.isFree(local))) {
      if (restoring) this.errors.set(remote, 'port-taken')
      return
    }
    const forward: Running = { remote, local, child: null }
    this.running.set(remote, forward)
    this.deps.map.set(this.deps.host, remote, local)
    this.spawn(remote, forward)
  }

  private addToMaster(remote: number, forward: Running, argv: string[]): void {
    const child = this.deps.spawn(argv)
    child.stdin.on('error', () => {})
    child.stdout.on('data', () => {})
    child.stderr.on('data', () => {})
    const ended = (code: number | null): void => {
      if (code === 0 || this.running.get(remote) !== forward) return
      this.running.delete(remote)
      this.errors.set(remote, 'forward-failed')
      this.deps.changed()
    }
    child.on('close', ended)
    child.on('error', () => ended(null))
  }

  private spawn(remote: number, forward: Running): void {
    const control = planControlForward(this.deps.plan, 'forward', remote, forward.local)
    if (control) {
      this.addToMaster(remote, forward, control)
      return
    }
    const child = this.deps.spawn(planForward(this.deps.plan, remote, forward.local))
    forward.child = child
    child.stdin.on('error', () => {})
    child.stdout.on('data', () => {})
    child.stderr.on('data', () => {})
    const ended = (): void => {
      if (forward.child !== child) return
      forward.child = null
      if (this.running.get(remote) !== forward || !this.online) return
      forward.timer = setTimeout(() => {
        if (this.running.get(remote) === forward && this.online) this.spawn(remote, forward)
      }, RESTART_MS)
      forward.timer.unref?.()
    }
    child.on('close', ended)
    child.on('error', ended)
  }

  private release(forward: Running): void {
    if (forward.timer) clearTimeout(forward.timer)
    const cancel = planControlForward(this.deps.plan, 'cancel', forward.remote, forward.local)
    if (cancel) {
      const child = this.deps.spawn(cancel)
      child.stdin.on('error', () => {})
      child.stdout.on('data', () => {})
      child.stderr.on('data', () => {})
      child.on('error', () => {})
      return
    }
    const child = forward.child
    forward.child = null
    child?.kill('SIGTERM')
  }
}
