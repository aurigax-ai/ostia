import { type ExtensionSettingValues, booleanSetting, numberSetting } from '../sdk'

const DEFAULT_POLL_SECONDS = 10
const POLL_SECONDS = { min: 2, max: 3600 }

export type GraphScopeSetting = 'current' | 'all'
export type ChangesView = 'list' | 'tree'

export interface GitSettings {
  pollMs: number
  showDiffStats: boolean
  graphScope: GraphScopeSetting
  changesView: ChangesView
}

export function readGitSettings(values: ExtensionSettingValues): GitSettings {
  return {
    pollMs: numberSetting(values, 'pollSeconds', DEFAULT_POLL_SECONDS, POLL_SECONDS) * 1000,
    showDiffStats: booleanSetting(values, 'showDiffStats', true),
    graphScope: values.graphScope === 'all' ? 'all' : 'current',
    changesView: values.changesView === 'tree' ? 'tree' : 'list',
  }
}
