import { type ExtensionSettingValues, booleanSetting, numberSetting } from '../sdk'

const DEFAULT_POLL_SECONDS = 10
const POLL_SECONDS = { min: 2, max: 3600 }

export interface GitSettings {
  pollMs: number
  showDiffStats: boolean
}

export function readGitSettings(values: ExtensionSettingValues): GitSettings {
  return {
    pollMs: numberSetting(values, 'pollSeconds', DEFAULT_POLL_SECONDS, POLL_SECONDS) * 1000,
    showDiffStats: booleanSetting(values, 'showDiffStats', true),
  }
}
