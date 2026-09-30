export type Capability =
  | 'drive-self'
  | 'read-board'
  | 'send-other-pane'
  | 'kill-pane'
  | 'all-workspaces'
  | 'shell'
  | 'destructive'
  | 'phone'
  | 'gateway'
  | 'notify'
  | 'process'
  | 'vault-read'
  | 'vault-write'
  | 'browse'
  | 'settings-read'
  | 'settings-write'
  | 'assist'
  | 'credentials'

export const DEFAULT_CAPABILITIES: Capability[] = [
  'drive-self',
  'read-board',
  'notify',
  'settings-read',
  'process',
  'vault-read',
  'vault-write',
]

export const ALL_CAPABILITIES: Capability[] = [
  'drive-self',
  'read-board',
  'send-other-pane',
  'kill-pane',
  'all-workspaces',
  'shell',
  'destructive',
  'phone',
  'gateway',
  'notify',
  'process',
  'vault-read',
  'vault-write',
  'browse',
  'settings-read',
  'settings-write',
  'assist',
  'credentials',
]

export const MANAGER_CAPABILITIES: Capability[] = ALL_CAPABILITIES.filter(
  (cap) => cap !== 'phone' && cap !== 'gateway' && cap !== 'destructive',
)

export const PHONE_BASE_CAPS = ['read', 'notify'] as const

export const PHONE_GRANTABLE_CAPS = ['command', 'input', 'destructive'] as const

export type PhoneGrantableCap = (typeof PHONE_GRANTABLE_CAPS)[number]

export type PhoneCap = (typeof PHONE_BASE_CAPS)[number] | PhoneGrantableCap
