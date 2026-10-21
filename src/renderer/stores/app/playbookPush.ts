import { useSettingsStore } from './settingsStore'

export function startPlaybookPush(): () => void {
  let last = useSettingsStore.getState().playbooks
  return useSettingsStore.subscribe((state) => {
    if (state.playbooks === last) return
    last = state.playbooks
    window.ostia.settings.setPlaybooks(state.playbooks)
  })
}
