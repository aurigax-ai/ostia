import { PRODUCT_DISPLAY_NAME } from './productDisplay'
export type Capability =
  | 'drive-self'
  | 'read-board'
  | 'send-other-pane'
  | 'type-other-pane'
  | 'read-other-pane'
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
  | 'language-server'
  | 'agent-plugin'

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
  'type-other-pane',
  'read-other-pane',
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
  'language-server',
  'agent-plugin',
]

export const MANAGER_CAPABILITIES: Capability[] = ALL_CAPABILITIES.filter(
  (cap) => cap !== 'phone' && cap !== 'gateway' && cap !== 'destructive',
)

export const CAPABILITY_ALLOWS: Record<Capability, string> = {
  'drive-self': 'control your own pane',
  'read-board': 'read the workspace and pane state',
  'send-other-pane': 'send messages to other panes',
  'type-other-pane': 'type into other terminal panes',
  'read-other-pane': 'read the screen of other terminal panes',
  'kill-pane': 'close panes',
  'all-workspaces': 'act on other panes and workspaces',
  shell: 'type commands into terminals',
  destructive: 'take destructive actions',
  phone: 'manage the phone companion',
  gateway: 'control the LAN gateway',
  notify: 'send notifications',
  process: 'run and manage background processes',
  'vault-read': 'read the vault',
  'vault-write': 'write the vault',
  browse: 'drive the in-app browser',
  'settings-read': 'read settings',
  'settings-write': 'change settings',
  assist: 'use the assistant',
  credentials: 'use your saved passwords and your signed-in browser',
  'language-server': 'run language servers',
  'agent-plugin': 'manage agent plugins',
}

export type CapabilityRefusal = 'denied' | 'not-approved'

export function capabilityRefusalHint(
  refusal: CapabilityRefusal,
  caps: readonly Capability[],
): string {
  const needed = caps.map((cap) => `${cap} (lets you ${CAPABILITY_ALLOWS[cap]})`).join(', ')
  const outcome =
    refusal === 'denied' ? 'The human denied it.' : 'Nobody answered the approval card in time.'
  const grant = `Only the human can grant it, by answering the approval card in ${PRODUCT_DISPLAY_NAME} or in Settings`
  const advice = 'ask the human or do this another way, and do not retry in a loop.'
  return `${outcome} Needed: ${needed}. ${grant}; ${advice}`
}
