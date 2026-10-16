export type WorkspaceLiveState = 'idle' | 'working' | 'waiting' | 'done' | 'error'

export type AttentionState = 'none' | 'working' | 'waiting' | 'done' | 'error'

const NOTIFICATION_KINDS = ['waiting', 'approval', 'done', 'error', 'message'] as const

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number]

export function notificationKindOf(value: unknown): NotificationKind {
  return NOTIFICATION_KINDS.includes(value as NotificationKind)
    ? (value as NotificationKind)
    : 'message'
}

export interface NotificationEntry {
  id: string
  ts: string
  kind: NotificationKind
  title: string
  body?: string
  from: string
  paneId?: string
  extId?: string
  panelPath?: string
}

export interface NotificationPost {
  paneId: string
  kind: NotificationKind
  title: string
  body?: string
  desktop: boolean
}

interface NotificationsApi {
  list: () => Promise<NotificationEntry[]>
  post: (post: NotificationPost) => void
  clear: () => void
  onChanged: (cb: () => void) => () => void
  onActivate: (cb: (paneId: string) => void) => () => void
  reveal: (paneId: string) => void
}

export type LifecycleEvent =
  | { type: 'pane-created'; workspaceId: string; paneId: string }
  | { type: 'pane-closed'; workspaceId: string; paneId: string }
  | { type: 'workspace-added'; workspaceId: string; workDir: string }
  | { type: 'workspace-closed'; workspaceId: string }
  | { type: 'workspace-activated'; workspaceId: string }
  | { type: 'workspace-state'; workspaceId: string; state: WorkspaceLiveState }
  | { type: 'pane-attention'; paneId: string; state: AttentionState; message?: string }

interface LifecycleApi {
  emit: (event: LifecycleEvent) => void
}

export interface AttentionBridge {
  lifecycle: LifecycleApi
  notifications: NotificationsApi
}
