import type { Capability } from '../capabilities'

export const SCRIPT_TOKEN_PREFIX = 'ostia_'

export const SCRIPT_CAPABILITIES: readonly Capability[] = [
  'read-board',
  'read-other-pane',
  'type-other-pane',
  'all-workspaces',
  'process',
  'send-other-pane',
  'kill-pane',
]
