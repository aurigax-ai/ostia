export type Capability =
  | 'drive-self'
  | 'read-board'
  | 'send-other-pane'
  | 'kill-pane'
  | 'workspace-wide'
  | 'shell'
  | 'destructive'
  | 'phone'
  | 'gateway'
  | 'notify'
  | 'process'
  | 'vault-read'
  | 'vault-write'
  | 'wiki-read'
  | 'wiki-write'
  | 'board-write'
  | 'browse'
  | 'settings-read'
  | 'settings-write'

export const DEFAULT_CAPABILITIES: Capability[] = [
  'drive-self',
  'read-board',
  'notify',
  'wiki-read',
  'wiki-write',
  'settings-read',
  'board-write',
  'process',
  'vault-read',
  'vault-write',
]

export const ALL_CAPABILITIES: Capability[] = [
  'drive-self',
  'read-board',
  'send-other-pane',
  'kill-pane',
  'workspace-wide',
  'shell',
  'destructive',
  'phone',
  'gateway',
  'notify',
  'process',
  'vault-read',
  'vault-write',
  'wiki-read',
  'wiki-write',
  'board-write',
  'browse',
  'settings-read',
  'settings-write',
]

export const PHONE_BASE_CAPS = ['read', 'board.read', 'notify'] as const

export const PHONE_GRANTABLE_CAPS = ['command', 'input', 'board.write', 'destructive'] as const

export type PhoneGrantableCap = (typeof PHONE_GRANTABLE_CAPS)[number]

export type PhoneCap = (typeof PHONE_BASE_CAPS)[number] | PhoneGrantableCap
