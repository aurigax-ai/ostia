import {
  type BrowserProfile,
  SHARED_BROWSER_PARTITION,
  isIsolatedBrowserPartition,
} from '../../shared/browserProfile'

export interface BrowserPaneOwner {
  windowId: string
  workspaceId: string
}

export interface BrowserProfilesDeps {
  ownerOf: (paneId: string) => BrowserPaneOwner | null
  isScratch: (workspaceId: string) => boolean
  isSandboxed: (workspaceId: string) => boolean
}

export class BrowserProfiles {
  private readonly profiles = new Map<string, BrowserProfile>()

  constructor(private readonly deps: BrowserProfilesDeps) {}

  private sharedAllowed(paneId: string, windowId: string): boolean {
    const owner = this.deps.ownerOf(paneId)
    if (!owner || owner.windowId !== windowId || !owner.workspaceId) return false
    return !this.deps.isScratch(owner.workspaceId) && !this.deps.isSandboxed(owner.workspaceId)
  }

  claim(paneId: unknown, windowId: string, requested: unknown): BrowserProfile {
    if (typeof paneId !== 'string' || !paneId) return 'isolated'
    const owner = this.deps.ownerOf(paneId)
    if (!owner || owner.windowId !== windowId) return 'isolated'
    const shared =
      requested === 'shared' &&
      this.profiles.get(paneId) !== 'isolated' &&
      this.sharedAllowed(paneId, windowId)
    const profile: BrowserProfile = shared ? 'shared' : 'isolated'
    this.profiles.set(paneId, profile)
    return profile
  }

  acceptsAttach(partition: string | undefined, windowId: string): boolean {
    if (isIsolatedBrowserPartition(partition)) return true
    if (partition !== SHARED_BROWSER_PARTITION) return false
    for (const [paneId, profile] of this.profiles) {
      if (profile === 'shared' && this.sharedAllowed(paneId, windowId)) return true
    }
    return false
  }

  profileOf(paneId: string): BrowserProfile {
    return this.profiles.get(paneId) ?? 'isolated'
  }

  isShared(paneId: string): boolean {
    return this.profiles.get(paneId) === 'shared'
  }

  forget(paneId: string): void {
    this.profiles.delete(paneId)
  }
}
