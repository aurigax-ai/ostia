export type ProgramSettingGroup =
  | 'behavior'
  | 'notifications'
  | 'agents'
  | 'terminal'
  | 'workspaces'

export const PROGRAM_SETTINGS: readonly { group: ProgramSettingGroup; field: string }[] = [
  { group: 'behavior', field: 'externalEditor' },
  { group: 'behavior', field: 'checkForUpdates' },
  { group: 'notifications', field: 'command' },
  { group: 'agents', field: 'autoResume' },
  { group: 'agents', field: 'autoSendReferences' },
  { group: 'agents', field: 'hooks' },
  { group: 'terminal', field: 'warnOnRiskyPaste' },
  { group: 'terminal', field: 'shell' },
  { group: 'terminal', field: 'osc52Write' },
  { group: 'terminal', field: 'keepShells' },
  { group: 'workspaces', field: 'globalHotkey' },
]
