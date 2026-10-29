import { readFileSync } from 'node:fs'
import { writeFileAtomic } from '@aurigax-ai/ostia-extension-sdk/atomicWrite'
import type { RemoteAgent } from '../../../shared/remote/remoteSetup'

export interface RemoteWorkspace {
  host: string
  folder: string
  agent: RemoteAgent
}

export interface RemoteTab {
  workspaceId: string
  host: string
  pane: string
}

export const REGISTRY_FILE = 'remote-workspaces.json'

function read(file: string): Record<string, RemoteWorkspace> {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, RemoteWorkspace>
  } catch {
    return {}
  }
}

export class RemoteRegistry {
  private readonly workspaces: Map<string, RemoteWorkspace>
  private readonly tabs = new Map<string, RemoteTab>()

  constructor(
    private readonly file: string | null,
    private readonly changed: () => void = () => {},
  ) {
    this.workspaces = new Map(Object.entries(file ? read(file) : {}))
  }

  private save(): void {
    if (!this.file) return
    writeFileAtomic(
      this.file,
      `${JSON.stringify(Object.fromEntries(this.workspaces), null, 2)}\n`,
      {
        mode: 0o600,
        dirMode: 0o700,
      },
    )
  }

  addWorkspace(workspaceId: string, workspace: RemoteWorkspace): void {
    this.workspaces.set(workspaceId, workspace)
    this.save()
    this.changed()
  }

  workspace(workspaceId: string): RemoteWorkspace | undefined {
    return this.workspaces.get(workspaceId)
  }

  workspaceIds(): string[] {
    return [...this.workspaces.keys()]
  }

  forgetWorkspace(workspaceId: string): void {
    if (this.workspaces.delete(workspaceId)) {
      this.save()
      this.changed()
    }
    for (const [paneId, tab] of this.tabs)
      if (tab.workspaceId === workspaceId) this.tabs.delete(paneId)
  }

  addTab(paneId: string, tab: RemoteTab): void {
    this.tabs.set(paneId, tab)
  }

  forgetTab(paneId: string): void {
    this.tabs.delete(paneId)
  }

  tabsOf(host: string): [string, RemoteTab][] {
    return [...this.tabs].filter(([, tab]) => tab.host === host)
  }

  hasWorkspaces(): boolean {
    return this.workspaces.size > 0
  }

  hosts(): string[] {
    return [...new Set([...this.workspaces.values()].map((w) => w.host))]
  }

  workspacesOn(host: string): string[] {
    return [...this.workspaces].filter(([, w]) => w.host === host).map(([id]) => id)
  }
}
