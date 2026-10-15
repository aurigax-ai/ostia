import { Duplex } from 'node:stream'
import type { PanelScope } from './panelServer'
import type { OwnedScreen } from './screenRegistry'
import { spawnViewer } from './screensCli'
import type { ScreensService } from './screensService'

const VIEW_PATH = /^\/view\/([A-Za-z0-9_-]{1,64})$/
const VIEWER_LINE = /^viewer (\S+)$/m

interface OpenViewer {
  screenId: string
  viewer: Promise<string | null>
  close: () => void
}

function key(panel: string, screenId: string): string {
  return `${panel}\u0000${screenId}`
}

export class Viewers {
  private readonly open = new Map<string, OpenViewer>()

  start(panel: string, screen: OwnedScreen): Duplex {
    this.open.get(key(panel, screen.id))?.close()
    const child = spawnViewer(screen.id, screen.viewerToken)
    let stderr = ''
    const viewer = new Promise<string | null>((resolve) => {
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8')
        const match = VIEWER_LINE.exec(stderr)
        if (match) resolve(match[1])
      })
      child.on('close', () => resolve(null))
      child.on('error', () => resolve(null))
    })
    const entry: OpenViewer = {
      screenId: screen.id,
      viewer,
      close: () => {
        child.kill('SIGTERM')
        if (this.open.get(key(panel, screen.id)) === entry) this.open.delete(key(panel, screen.id))
      },
    }
    this.open.set(key(panel, screen.id), entry)
    child.on('close', () => {
      if (this.open.get(key(panel, screen.id)) === entry) this.open.delete(key(panel, screen.id))
    })
    if (!child.stdout || !child.stdin) throw new Error('screens view has no pipes')
    const stream = Duplex.from({ readable: child.stdout, writable: child.stdin })
    stream.on('close', () => entry.close())
    stream.on('error', () => entry.close())
    return stream
  }

  viewerOf(panel: string, screenId: string): Promise<string | null> {
    return this.open.get(key(panel, screenId))?.viewer ?? Promise.resolve(null)
  }

  closeScreen(screenId: string): void {
    for (const entry of [...this.open.values()]) if (entry.screenId === screenId) entry.close()
  }

  closeAll(): void {
    for (const entry of [...this.open.values()]) entry.close()
  }
}

export function viewStream(
  service: ScreensService,
  viewers: Viewers,
): (scope: PanelScope, rest: string) => Duplex | null {
  return (scope, rest) => {
    const id = VIEW_PATH.exec(rest)?.[1]
    const screen = id ? service.registry.get(id) : undefined
    if (!screen || screen.workspaceId !== scope.workspaceId) return null
    return viewers.start(scope.panel, screen)
  }
}
