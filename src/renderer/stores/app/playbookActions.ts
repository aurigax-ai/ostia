import {
  withOwnPlaybook,
  withoutOwnPlaybook,
  withPlaybookAccepted,
  withPlaybookEnabled,
  withPlaybookReset,
  withPlaybookText,
} from '@shared/agents/playbooks'
import type { StoreApi } from 'zustand'
import type { SettingsState } from './settingsModel'
import { scheduleSave } from './settingsPersist'

type SetSettings = StoreApi<SettingsState>['setState']
type GetSettings = () => SettingsState

export function createPlaybookActions(
  set: SetSettings,
  get: GetSettings,
): Pick<
  SettingsState,
  | 'setPlaybookEnabled'
  | 'setPlaybookText'
  | 'resetPlaybook'
  | 'acceptPlaybook'
  | 'saveOwnPlaybook'
  | 'deleteOwnPlaybook'
> {
  return {
    setPlaybookEnabled: (id, enabled) => {
      set((s) => ({ playbooks: withPlaybookEnabled(s.playbooks, id, enabled) }))
      scheduleSave(get)
    },
    setPlaybookText: (id, text) => {
      set((s) => ({ playbooks: withPlaybookText(s.playbooks, id, text) }))
      scheduleSave(get)
    },
    resetPlaybook: (id) => {
      set((s) => ({ playbooks: withPlaybookReset(s.playbooks, id) }))
      scheduleSave(get)
    },
    acceptPlaybook: (id) => {
      set((s) => ({ playbooks: withPlaybookAccepted(s.playbooks, id) }))
      scheduleSave(get)
    },
    saveOwnPlaybook: (name, fields, replaces) => {
      set((s) => ({ playbooks: withOwnPlaybook(s.playbooks, name, fields, replaces) }))
      scheduleSave(get)
    },
    deleteOwnPlaybook: (name) => {
      set((s) => ({ playbooks: withoutOwnPlaybook(s.playbooks, name) }))
      scheduleSave(get)
    },
  }
}
