import type { Socket } from 'node:net'
import { type OwnedScreen, ScreenRegistry, workspaceLabel } from './screenRegistry'
import {
  createLeased,
  isOutdated,
  type ListedScreen,
  runScreens,
  type ScreensResult,
  serviceVersion,
} from './screensCli'

interface ScreenSize {
  width?: number
  height?: number
}

export interface CreateRequest extends ScreenSize {
  workspaceId: string
  allow: string[]
}

export interface ShownScreen {
  id: string
  width: number
  height: number
  owner: string
  state: string
  backend: string
}

export interface ScreensServiceHooks {
  created?: (screen: OwnedScreen) => void
  stopped?: (screen: OwnedScreen) => void
}

export class ScreensService {
  readonly registry = new ScreenRegistry()
  private readonly leases = new Map<string, Socket>()

  constructor(private readonly hooks: ScreensServiceHooks = {}) {}

  async outdatedVersion(): Promise<string | null> {
    const version = await serviceVersion()
    return version !== null && isOutdated(version) ? version : null
  }

  async create(req: CreateRequest): Promise<ScreensResult<OwnedScreen>> {
    const outdated = await this.outdatedVersion()
    if (outdated) return { ok: false, code: 'outdated', message: outdated }
    const res = await createLeased({
      width: req.width,
      height: req.height,
      allow: req.allow,
      label: workspaceLabel(req.workspaceId),
    })
    if (!res.ok) return res
    const screen: OwnedScreen = { ...res.value.screen, workspaceId: req.workspaceId }
    this.adopt(screen, res.value.lease)
    return { ok: true, value: screen }
  }

  adopt(screen: OwnedScreen, lease: Socket): void {
    this.registry.add(screen)
    this.leases.set(screen.id, lease)
    lease.on('close', () => void this.leaseClosed(screen.id))
    this.hooks.created?.(screen)
  }

  async stop(id: string): Promise<ScreensResult<{ id: string }>> {
    const screen = this.registry.get(id)
    if (!screen) return { ok: false, code: 'not-found', message: `no screen ${id}` }
    const res = await runScreens<{ id: string }>({ args: ['stop', id], token: screen.agentToken })
    if (res.ok || res.code === 'not-found') this.forget(id)
    return res.ok ? res : res.code === 'not-found' ? { ok: true, value: { id } } : res
  }

  async stopWorkspace(workspaceId: string): Promise<void> {
    await Promise.all(this.registry.inWorkspace(workspaceId).map((s) => this.stop(s.id)))
  }

  stopAllNow(): void {
    for (const screen of this.registry.all()) this.forget(screen.id)
  }

  private async leaseClosed(id: string): Promise<void> {
    if (!this.registry.get(id)) return
    const listed = await runScreens<{ screens: ListedScreen[] }>({ args: ['list'] })
    if (listed.ok && listed.value.screens.some((s) => s.id === id)) await this.stop(id)
    else this.forget(id)
  }

  async shown(workspaceId: string): Promise<ShownScreen[]> {
    const owned = this.registry.inWorkspace(workspaceId)
    if (owned.length === 0) return []
    const res = await runScreens<{ screens: ListedScreen[] }>({ args: ['list'] })
    const listed = new Map(res.ok ? res.value.screens.map((s) => [s.id, s]) : [])
    const shown: ShownScreen[] = []
    for (const screen of owned) {
      const live = listed.get(screen.id)
      if (res.ok && !live) {
        this.forget(screen.id)
        continue
      }
      shown.push({
        id: screen.id,
        width: screen.width,
        height: screen.height,
        owner: live?.owner ?? 'agent',
        state: live?.state ?? 'running',
        backend: live?.backend ?? 'xvnc',
      })
    }
    return shown
  }

  private forget(id: string): void {
    this.leases.get(id)?.destroy()
    this.leases.delete(id)
    const screen = this.registry.remove(id)
    if (screen) this.hooks.stopped?.(screen)
  }
}
