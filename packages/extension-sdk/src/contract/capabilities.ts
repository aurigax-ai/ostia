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
  | 'mcp'
  | 'read-bus'
  | 'file-contents'

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
  'mcp',
  'read-bus',
  'file-contents',
]

export const HUMAN_GRANTED_CAPABILITIES: readonly Capability[] = [
  'mcp',
  'read-bus',
  'file-contents',
]

export const BUILTIN_CAPABILITIES: Capability[] = ALL_CAPABILITIES.filter(
  (cap) => !HUMAN_GRANTED_CAPABILITIES.includes(cap),
)

export const MANAGER_CAPABILITIES: Capability[] = ALL_CAPABILITIES.filter(
  (cap) =>
    cap !== 'phone' &&
    cap !== 'gateway' &&
    cap !== 'destructive' &&
    cap !== 'mcp' &&
    cap !== 'read-bus' &&
    cap !== 'file-contents',
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
  mcp: 'call the MCP servers you set up',
  'read-bus': 'see which panes send each other bus messages, never what they say',
  'file-contents': 'read the files you expand in Files, to list and open what is inside them',
}

export type CapabilityRefusal = 'denied' | 'not-approved'

export function capabilityRefusalHint(
  refusal: CapabilityRefusal,
  caps: readonly Capability[],
): string {
  const needed = caps.map((cap) => `${cap} lets you ${CAPABILITY_ALLOWS[cap]}`).join('; ')
  const outcome = refusal === 'denied' ? 'The human denied it' : 'Nobody answered in time'
  return `${outcome}. ${needed}; only the human grants it, in ${PRODUCT_DISPLAY_NAME} or Settings. Ask them or work another way; do not retry.`
}
