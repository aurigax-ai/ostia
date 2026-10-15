import type { PaneProcess } from '../panes/paneProcess'
import type { PortBridge } from '../sandbox/portBridge'
import type { KeptMeta } from '../tmux/keptShells'
import type { TmuxPane } from '../tmux/tmuxServer'
import type { PtyFlowControl } from './ptyFlow'
import type { PtySession } from './ptySession'
import type { ScreenMirror } from './screenMirror'

export interface PaneTitleEntry {
  paneId: string
  title: string
}

export interface PtyEntry {
  paneId: string
  pty: PaneProcess
  kept: TmuxPane | null
  keptMeta: KeptMeta | null
  session: PtySession
  flow: PtyFlowControl
  mirror: ScreenMirror
  subs: Map<string, Electron.WebContents>
  killTimer: ReturnType<typeof setTimeout> | null
  spawnPath: string
  stateFile: string
  workspaceId: string
  sandboxed: boolean
  shell: string
  sandboxStamp: string | null
  portBridge: PortBridge | null
  confinedBy: string | null
  keepAlive: boolean
  exitListeners: Set<(code: number) => void>
}
