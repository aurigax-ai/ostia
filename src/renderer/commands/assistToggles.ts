import { currentDict, fmt } from '../i18n/useDict'
import { toggleAssistFeature, toggleCommandId } from '../lib/assistFeatures'
import { useAssistStore } from '../stores/assistStore'
import { commands } from './registry'

const registered = new Set<string>()

function syncToggleCommands(): void {
  const d = currentDict()
  const wanted = new Map<string, () => void>()
  const titles = new Map<string, string>()
  for (const ext of useAssistStore.getState().overview) {
    for (const feature of ext.features) {
      const id = toggleCommandId(ext.extId, feature)
      wanted.set(id, () => {
        const current = useAssistStore
          .getState()
          .overview.find((e) => e.extId === ext.extId)
          ?.features.find((f) => f.id === feature.id)
        if (current) void toggleAssistFeature(ext.extId, current)
      })
      titles.set(
        id,
        fmt(d.assistMenu.toggleTitle, { feature: d.assistMenu.feature[feature.id] ?? feature.id }),
      )
    }
  }
  for (const id of [...registered]) {
    if (wanted.has(id)) continue
    commands.unregister(id)
    registered.delete(id)
  }
  for (const [id, run] of wanted) {
    if (registered.has(id) || commands.has(id)) continue
    commands.register({
      id,
      title: titles.get(id) ?? id,
      category: 'Assistant',
      target: 'none',
      run,
    })
    registered.add(id)
  }
}

export function startAssistToggleCommands(): () => void {
  syncToggleCommands()
  return useAssistStore.subscribe((s, prev) => {
    if (s.overview !== prev.overview) syncToggleCommands()
  })
}
