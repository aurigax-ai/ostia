import type { CreatedScreen } from './screensCli'

export interface OwnedScreen extends CreatedScreen {
  workspaceId: string
}

const WORKSPACE_LABEL_PREFIX = 'workspace:'

export function workspaceLabel(workspaceId: string): string {
  return `${WORKSPACE_LABEL_PREFIX}${workspaceId}`
}

export class ScreenRegistry {
  private readonly screens = new Map<string, OwnedScreen>()

  add(screen: OwnedScreen): void {
    this.screens.set(screen.id, screen)
  }

  remove(id: string): OwnedScreen | undefined {
    const screen = this.screens.get(id)
    this.screens.delete(id)
    return screen
  }

  get(id: string): OwnedScreen | undefined {
    return this.screens.get(id)
  }

  inWorkspace(workspaceId: string): OwnedScreen[] {
    return [...this.screens.values()].filter((s) => s.workspaceId === workspaceId)
  }

  all(): OwnedScreen[] {
    return [...this.screens.values()]
  }
}
